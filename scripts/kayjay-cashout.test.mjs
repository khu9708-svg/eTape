import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { discoverCashoutRails, selectCashoutRail, planCashout, createFiatWithdrawal, createOfframpSession, CashoutError } from './kayjay-cashout.mjs';

const creds = () => ({ name: 'test', secret: generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64') });
const ok = body => ({ ok: true, status: 200, json: async () => body });

test('unauthenticated discovery reports every rail unavailable without a network call', async () => {
  let calls = 0;
  const state = await discoverCashoutRails({ name: '', secret: '' }, async () => { calls++; return ok({}); });
  assert.equal(calls, 0);
  assert.equal(state.authenticated, false);
  for (const key of ['instantCard', 'rtp', 'paypal', 'cdpOfframp']) assert.equal(state.rails[key].candidate, false);
});

test('a verified withdraw-enabled card becomes the instant card rail (real WORLDPAY_CARD type)', async () => {
  const send = async () => ok({ payment_methods: [
    { id: 'pm-card', type: 'WORLDPAY_CARD', currency: 'USD', verified: true, allow_withdraw: true, name: 'Visa ****1234' },
    { id: 'pm-ach', type: 'ACH', currency: 'USD', verified: true, allow_withdraw: true },
    { id: 'pm-applepay', type: 'APPLE_PAY', currency: 'USD', verified: true },
  ] });
  const state = await discoverCashoutRails(creds(), send);
  assert.equal(state.authenticated, true);
  assert.equal(state.country, 'US');
  assert.equal(state.rails.instantCard.candidate, true);
  assert.equal(state.rails.instantCard.paymentMethodId, 'pm-card');
  const picked = selectCashoutRail(state);
  assert.equal(picked.selected, 'instantCard');
});

test('an unverified card is reported as a non-candidate with the real reason', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pm-card', type: 'WORLDPAY_CARD', currency: 'USD', verified: false, allow_withdraw: true }] });
  const state = await discoverCashoutRails(creds(), send);
  assert.equal(state.rails.instantCard.candidate, false);
  assert.match(state.rails.instantCard.reason, /not verified/);
});

test('planCashout discovers, selects and returns an owner-gated plan', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pm-card', type: 'WORLDPAY_CARD', currency: 'USD', verified: true, allow_withdraw: true }] });
  const plan = await planCashout({ amount: '25.00' }, creds(), send);
  assert.equal(plan.selected, 'instantCard');
  assert.equal(plan.quote.paymentMethodId, 'pm-card');
  assert.equal(plan.ready, true);
  assert.equal(plan.ownerActionRequired, 'OWNER LIVE VERIFY REQUIRED');
  await assert.rejects(planCashout({ amount: 'nope' }, creds(), send), (e) => e.code === 'invalid_amount');
});

test('createFiatWithdrawal refuses without owner confirmation and is idempotent with a store', async () => {
  const m = new Map();
  const store = { get: async k => m.get(k), insertIfAbsent: async (k, v) => { if (m.has(k)) return false; m.set(k, v); return true; }, put: async (k, v) => m.set(k, v) };
  await assert.rejects(createFiatWithdrawal({ accountId: 'a', paymentMethodId: 'p', amount: '10', clientId: 'kj-w-0001' }, creds(), async () => ok({}), store), (e) => e.code === 'owner_confirmation_required');
  let calls = 0;
  const send = async () => { calls++; return ok({ data: { id: 'wd-1', status: 'created', amount: { amount: '10.00' } } }); };
  const first = await createFiatWithdrawal({ accountId: 'a', paymentMethodId: 'p', amount: '10', clientId: 'kj-w-0001', owner: true, confirm: true }, creds(), send, store);
  assert.equal(first.withdrawalId, 'wd-1');
  const dup = await createFiatWithdrawal({ accountId: 'a', paymentMethodId: 'p', amount: '10', clientId: 'kj-w-0001', owner: true, confirm: true }, creds(), send, store);
  assert.equal(dup.duplicate, true);
  assert.equal(calls, 1);
});

test('createOfframpSession needs owner confirm and returns an official hosted URL', async () => {
  await assert.rejects(createOfframpSession({ amount: '10', address: 'abc' }, creds(), async () => ok({})), (e) => e.code === 'owner_confirmation_required');
  const send = async () => ok({ token: 'sess-abc' });
  const s = await createOfframpSession({ amount: '10', asset: 'USDC', network: 'solana', address: 'BSB3iG3E8Lmt6Q59cLqYmZUCgM9FKuc39pgXd5rUcF17', owner: true, confirm: true }, creds(), send);
  assert.ok(s.hostedUrl.startsWith('https://pay.coinbase.com/v3/sell/input?'));
  assert.match(s.hostedUrl, /sessionToken=sess-abc/);
  assert.equal(s.ownerActionRequired, 'OWNER LIVE VERIFY REQUIRED');
});

test('no instant rail and instantOnly fails clearly with no ACH fallback', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pm-ach', type: 'ACH_BANK_ACCOUNT', currency: 'USD', verified: true, allow_withdraw: true }] });
  const state = await discoverCashoutRails(creds(), send);
  // cdpOfframp is always a candidate once authenticated, so instantOnly still resolves to it.
  assert.equal(selectCashoutRail(state).selected, 'cdpOfframp');
  // but with cdpOfframp explicitly excluded there is genuinely nothing instant:
  state.rails.cdpOfframp.candidate = false;
  assert.throws(() => selectCashoutRail(state), (e) => e instanceof CashoutError && e.code === 'no_instant_rail');
});

test('a Coinbase auth rejection surfaces as coinbase_auth_required, not a rail', async () => {
  const send = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(discoverCashoutRails(creds(), send), (e) => e instanceof CashoutError && e.code === 'coinbase_auth_required');
});

test('a PayPal account only counts when verified and withdraw-enabled', async () => {
  const send = async () => ok({ payment_methods: [{ id: 'pp', type: 'PAYPAL_ACCOUNT', currency: 'USD', verified: true, allow_withdraw: true }] });
  const state = await discoverCashoutRails(creds(), send);
  assert.equal(state.rails.paypal.candidate, true);
  assert.equal(state.rails.paypal.paymentMethodId, 'pp');
});
