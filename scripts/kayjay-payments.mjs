// Official contract: docs.cdp.coinbase.com/api-reference/v2/rest-api/onramp/
// This adapter prepares SANDBOX Coinbase Onramp funding only. It never signs or
// funds a payout. Coinbase is the sole payment provider; there is no other rail.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export class PaymentError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'PaymentError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new PaymentError(code, message, status); };
const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('invalid_id', 'A valid payment reference is required.');
  return value;
};
const amount = value => {
  if (typeof value !== 'string' || !/^\d{1,8}(\.\d{1,2})?$/.test(value) || Number(value) <= 0) fail('invalid_amount', 'Enter a positive amount with at most two decimal places.');
  return value;
};
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
const CB = 'https://api.cdp.coinbase.com';
const ORDER = '/platform/v2/onramp/orders';

// Parent supplies an existing ~/.eTape/ path. No directory or credential is created.
// insertIfAbsent is cross-process atomic; stale locks fail closed for operator recovery.
export function createFileIntentStore(file) {
  if (!isAbsolute(file)) fail('invalid_store', 'Payment state requires an absolute local file path.');
  async function read() {
    try { const parsed = JSON.parse(await readFile(file, 'utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed; }
    catch (e) { if (e.code === 'ENOENT') return {}; fail('state_unavailable', 'Payment state cannot be read safely.', 503); }
  }
  async function mutate(fn) {
    let lock;
    try { lock = await open(file + '.lock', 'wx', 0o600); }
    catch { fail('state_busy', 'Payment state is locked or unavailable. No provider request was sent.', 503); }
    const tmp = file + '.' + randomUUID() + '.tmp';
    try {
      const state = await read(); const result = fn(state);
      const output = await open(tmp, 'wx', 0o600);
      try { await output.writeFile(JSON.stringify(state)); await output.sync(); } finally { await output.close(); }
      await rename(tmp, file); return result;
    } finally { await unlink(tmp).catch(() => {}); await lock.close(); await unlink(file + '.lock'); }
  }
  return {
    get: async key => { const state = await read(); id(key); return Object.hasOwn(state, key) ? state[key] : null; },
    insertIfAbsent: (key, record) => mutate(state => {
      id(key); if (Object.hasOwn(state, key)) return false;
      Object.defineProperty(state, key, { value: record, enumerable: true, writable: true }); return true;
    }),
    put: (key, record) => mutate(state => { id(key); Object.defineProperty(state, key, { value: record, enumerable: true, writable: true }); }),
  };
}

// send follows fetch's signature; signJwt(method,path,host) returns a JWT string.
// store must durably/atomically insertIfAbsent BEFORE any mutating provider call.
export function createPaymentAdapter({ signJwt, store, send = fetch, timeoutMs = 12000 } = {}) {
  if (!store?.get || !store?.insertIfAbsent || !store?.put) fail('state_required', 'Persistent payment state is required.', 503);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('invalid_timeout', 'Invalid payment timeout.');

  function requireAuth() {
    if (!signJwt) fail('coinbase_auth_required', 'Coinbase CDP authentication is not configured.', 503);
  }

  async function request(method, path, body) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    requireAuth();
    try { headers.Authorization = 'Bearer ' + await signJwt(method, path, new URL(CB).host); }
    catch { fail('coinbase_auth_failed', 'Coinbase authentication could not be prepared.', 503); }
    const controller = new AbortController(); let timer;
    try {
      const work = async () => {
        const response = await send(CB + path, { method, headers, ...(serialized ? { body: serialized } : {}), redirect: 'error', signal: controller.signal });
        if (!response.ok) fail('provider_rejected', `Payment provider returned HTTP ${Number(response.status) || 502}.`, 502);
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.errors || data.errorType) fail('provider_invalid_response', 'Payment provider did not return a valid result.', 502);
        return data;
      };
      return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PaymentError('provider_timeout', 'Payment provider response timed out; reconcile before retrying.', 504)); }, timeoutMs); })]);
    } catch (e) { if (e instanceof PaymentError) throw e; fail('provider_unavailable', 'Payment provider response is unavailable; reconcile before retrying.', 502); }
    finally { clearTimeout(timer); }
  }

  async function intent(key, kind, input, execute) {
    id(key);
    requireAuth();
    const fingerprint = hash(canonical({ kind, ...input }));
    const prior = await store.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('intent_conflict', 'This payment reference already belongs to different details.', 409);
      if (prior.state === 'received') return { ...prior.result, duplicate: true };
      fail('outcome_unknown', 'This request may already have reached the provider. Reconcile its status before another attempt.', 409);
    }
    const record = { kind, fingerprint, state: 'pending', createdAt: new Date().toISOString() };
    if (!await store.insertIfAbsent(key, record)) fail('intent_in_progress', 'This payment reference is already being processed.', 409);
    let result;
    try {
      result = await execute();
      await store.put(key, { ...record, state: 'received', result });
      return result;
    } catch (e) {
      await store.put(key, { ...record, state: 'unknown', ...(result ? { result } : {}), errorCode: e instanceof PaymentError ? e.code : 'state_unavailable' }).catch(() => {});
      if (e instanceof PaymentError) throw e;
      fail('outcome_unknown', 'Payment outcome could not be saved. Reconcile before retrying.', 503);
    }
  }

  function cbInput(input, quote) {
    if (!input || !/^sandbox-[a-zA-Z0-9_-]{1,42}$/.test(input.partnerUserRef ?? '')) fail('sandbox_required', 'Use a sandbox owner reference; live funding is not enabled.');
    if (!['base', 'ethereum', 'solana'].includes(input.destinationNetwork)) fail('network_required', 'Choose a supported destination network.');
    const wallet = input.destinationAddress;
    if (input.destinationNetwork === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet ?? '') : !/^0x[a-fA-F0-9]{40}$/.test(wallet ?? '')) fail('wallet_required', 'A valid destination wallet is required.');
    if (input.purchaseCurrency !== 'USDC') fail('asset_required', 'This funding integration currently supports USDC.');
    if (input.paymentCurrency && input.paymentCurrency !== 'USD') fail('currency_required', 'USD is required.');
    return { destinationAddress: wallet, destinationNetwork: input.destinationNetwork, partnerUserRef: input.partnerUserRef,
      paymentCurrency: 'USD', paymentMethod: 'GUEST_CHECKOUT_APPLE_PAY', purchaseCurrency: 'USDC', paymentAmount: amount(input.paymentAmount), isQuote: quote, domain: 'localhost' };
  }
  function cbResult(data, needsLink = false) {
    const order = data.order;
    if (!order || typeof order !== 'object') fail('provider_invalid_response', 'Coinbase order result is incomplete.', 502);
    const result = { provider: 'coinbase', environment: 'sandbox', order: pick(order, ['orderId','status','paymentTotal','paymentSubtotal','paymentCurrency','purchaseAmount','purchaseCurrency','destinationNetwork','createdAt','updatedAt','txHash','partnerUserRef','fees']) };
    if (needsLink) {
      if (!/^sandbox-/.test(order.partnerUserRef ?? '')) fail('provider_invalid_response', 'Coinbase did not confirm a sandbox owner reference.', 502);
      let link; try { link = new URL(data.paymentLink?.url); } catch { fail('provider_invalid_response', 'Coinbase did not return a payment link.', 502); }
      if (link.origin !== 'https://pay.coinbase.com' || !link.pathname.startsWith('/v2/api-onramp/') || link.username || link.password) fail('provider_invalid_response', 'Coinbase returned an unsupported payment link.', 502);
      id(order.orderId); link.searchParams.set('useApplePaySandbox', 'true'); result.paymentUrl = link.toString();
    }
    return result;
  }
  const api = {
    coinbaseQuote: async input => cbResult(await request('POST', ORDER, cbInput(input, true))),
    coinbaseSandboxStart: (input, key) => { const body = cbInput(input, false); return intent(key, 'coinbase_start', body, async () => cbResult(await request('POST', ORDER, body), true)); },
    coinbaseStatus: async orderId => {
      const data = await request('GET', ORDER + '/' + id(orderId));
      if (data.order?.orderId !== orderId || !/^sandbox-/.test(data.order?.partnerUserRef ?? '')) fail('provider_invalid_response', 'Coinbase did not return the requested sandbox order.', 502);
      return cbResult(data);
    },
    reconcileIntent: async key => {
      const record = await store.get(id(key));
      if (!record) fail('intent_not_found', 'Payment reference was not found.', 404);
      const result = record.result;
      if (!result?.order?.orderId) return { state: 'unknown', retryAllowed: false, message: 'No provider order reference was received. Provider history or support reconciliation is required before a new attempt.' };
      const status = await api.coinbaseStatus(result.order.orderId);
      await store.put(key, { ...record, lastReconciledAt: new Date().toISOString(), latestStatus: status });
      return { state: 'reconciled', retryAllowed: false, ...status };
    },
  };
  return api;
}
