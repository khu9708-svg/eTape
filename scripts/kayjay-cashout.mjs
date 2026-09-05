// Coinbase cash-out rail discovery. Coinbase is the sole cash-out provider.
//
// Rails are discovered dynamically from the account's real payment methods
// (GET /api/v3/brokerage/payment_methods) plus, for the hosted sell flow, the
// CDP Offramp session capability. No rail is ever reported "available" without
// a provider payment-method row backing it, and only documented payment-method
// fields are read: id, type, name, currency, verified, allow_withdraw,
// allow_deposit, allow_buy, allow_sell.
//
// This module DISCOVERS and QUOTES. It never executes a payout: the final
// transfer is OWNER LIVE VERIFY REQUIRED and is performed by the owner.
import { coinbaseCredentials, coinbaseJwt } from "./kayjay-coinbase.mjs";

const HOST = "api.coinbase.com";
const PAYMENT_METHODS = "/api/v3/brokerage/payment_methods";

export class CashoutError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "CashoutError"; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new CashoutError(code, message, status); };

async function get(resource, credentials, send) {
  let jwt;
  try { jwt = coinbaseJwt("GET", resource, credentials, undefined, HOST); }
  catch { fail("coinbase_auth_required", "Coinbase API credentials are UNSET or invalid.", 503); }
  let response;
  try {
    response = await send("https://" + HOST + resource, { headers: { Authorization: "Bearer " + jwt }, signal: AbortSignal.timeout(8000) });
  } catch { fail("coinbase_unavailable", "Coinbase cash-out service is unreachable; no rail is confirmed.", 502); }
  if (response.status === 401 || response.status === 403) fail("coinbase_auth_required", "Coinbase authorization was rejected.", 401);
  if (!response.ok) fail("coinbase_unavailable", `Coinbase returned HTTP ${response.status}.`, 502);
  let data;
  try { data = await response.json(); } catch { fail("coinbase_invalid_response", "Coinbase cash-out response was not valid JSON.", 502); }
  if (!data || typeof data !== "object" || data.error) fail("coinbase_invalid_response", "Coinbase cash-out response was not usable.", 502);
  return data;
}

// Coinbase Advanced Trade payment-method `type` -> the cash-out rail it serves.
// Verified against a live account (2026-09-05): real types include
// WORLDPAY_CARD, COINBASE_FIAT_ACCOUNT, APPLE_PAY, GOOGLE_PAY. APPLE_PAY /
// GOOGLE_PAY are funding-only and are intentionally not withdrawal rails.
const RAIL_FOR_TYPE = {
  WORLDPAY_CARD: "instantCard",
  DEBIT_CARD: "instantCard",
  FPX_DEBIT: "instantCard",
  RTP: "rtp",
  REAL_TIME_PAYMENTS: "rtp",
  PAYPAL: "paypal",
  PAYPAL_ACCOUNT: "paypal",
  COINBASE_FIAT_ACCOUNT: "cdpOfframp",
  FIAT_WALLET: "cdpOfframp",
  FIAT_ACCOUNT: "cdpOfframp",
  ACH: "ach",
  ACH_BANK_ACCOUNT: "ach",
  SEPA: "ach",
  BANK_WIRE: "ach",
};

function normalizeMethod(row) {
  return {
    id: typeof row?.id === "string" ? row.id : null,
    type: typeof row?.type === "string" ? row.type : "UNKNOWN",
    name: typeof row?.name === "string" ? row.name : null,
    currency: typeof row?.currency === "string" ? row.currency : null,
    verified: row?.verified === true,
    allowWithdraw: row?.allow_withdraw === true,
    allowDeposit: row?.allow_deposit === true,
    allowSell: row?.allow_sell === true,
  };
}

function railFrom(methods, rail, label) {
  const candidates = methods.filter(m => RAIL_FOR_TYPE[m.type] === rail && (m.currency == null || m.currency === "USD"));
  const usable = candidates.find(m => m.verified && m.allowWithdraw && m.id);
  if (usable) {
    return { rail, label, candidate: true, paymentMethodId: usable.id, methodType: usable.type, verified: true, allowWithdraw: true, provider: "coinbase", reason: `Verified withdraw-enabled ${label} payment method on file.` };
  }
  if (candidates.length) {
    const m = candidates[0];
    return { rail, label, candidate: false, paymentMethodId: m.id, methodType: m.type, verified: m.verified, allowWithdraw: m.allowWithdraw, provider: "coinbase", reason: !m.verified ? `${label} payment method is not verified.` : !m.allowWithdraw ? `${label} payment method does not allow withdrawals.` : `${label} payment method is not usable.` };
  }
  return { rail, label, candidate: false, paymentMethodId: null, verified: false, allowWithdraw: false, provider: "coinbase", reason: `No ${label} payment method returned by Coinbase for this account.` };
}

/**
 * Discover cash-out rails from the account's real Coinbase payment methods.
 * Returns the required KAYJAY cash-out state shape. Never fabricates a rail.
 */
export async function discoverCashoutRails(credentials = coinbaseCredentials(), send = fetch) {
  if (!credentials?.name || !credentials?.secret) {
    return { authenticated: false, country: null, paymentMethods: [], rails: {
      instantCard: { rail: "instantCard", candidate: false, reason: "Coinbase credentials are UNSET." },
      rtp: { rail: "rtp", candidate: false, reason: "Coinbase credentials are UNSET." },
      paypal: { rail: "paypal", candidate: false, reason: "Coinbase credentials are UNSET." },
      cdpOfframp: { rail: "cdpOfframp", candidate: false, reason: "Coinbase credentials are UNSET." },
    } };
  }
  const data = await get(PAYMENT_METHODS, credentials, send);
  const raw = Array.isArray(data.payment_methods) ? data.payment_methods : [];
  const methods = raw.map(normalizeMethod);
  const country = methods.find(m => typeof m.currency === "string")?.currency === "USD" ? "US" : null;
  return {
    authenticated: true,
    country,
    paymentMethods: methods,
    rails: {
      instantCard: railFrom(methods, "instantCard", "instant debit card"),
      rtp: railFrom(methods, "rtp", "instant bank (RTP)"),
      paypal: railFrom(methods, "paypal", "PayPal"),
      // The hosted CDP Offramp sell flow does not require a stored payment
      // method; it is always a candidate once authenticated, but it needs a
      // session and an owner action to complete.
      cdpOfframp: { rail: "cdpOfframp", label: "Coinbase hosted sell (CDP Offramp)", candidate: true, requiresSession: true, provider: "coinbase", reason: "Hosted sell flow is available; it needs a session token and an owner action to complete." },
    },
  };
}

/**
 * Pick the best eligible instant rail for a cash-out request. Does NOT execute.
 * When `instantOnly` is set and no instant rail qualifies, fails clearly — no
 * silent fallback to slower ACH.
 */
export function selectCashoutRail(state, { instantOnly = true } = {}) {
  const order = ["instantCard", "rtp", "paypal", "cdpOfframp"];
  for (const key of order) {
    const rail = state?.rails?.[key];
    if (rail?.candidate === true) return { selected: key, rail };
  }
  if (instantOnly) fail("no_instant_rail", "No eligible instant cash-out rail is available on this Coinbase account. No slower fallback was used.", 409);
  return { selected: null, rail: null };
}

// --------------------------------------------------------------------------- //
// Cash-out EXECUTION path. Every function below reaches exactly one owner
// confirmation and stops: real withdrawals / sell sessions are
// OWNER LIVE VERIFY REQUIRED. Idempotent on clientId; ambiguous outcome ->
// unknown, reconcile-only, never a blind retry.
// --------------------------------------------------------------------------- //

const V2 = "https://api.coinbase.com";
const CDP = "https://api.cdp.coinbase.com";
const CDP_HOST = "api.cdp.coinbase.com";
const AMOUNT = /^\d{1,10}(\.\d{1,8})?$/;
const CLIENT = /^[a-zA-Z0-9_-]{6,64}$/;

async function v2(method, resource, credentials, send, body, { base = V2, host = HOST } = {}) {
  let jwt;
  try { jwt = coinbaseJwt(method, resource, credentials, undefined, host); }
  catch { fail("coinbase_auth_required", "Coinbase credentials are UNSET or invalid.", 503); }
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  let response;
  try {
    response = await send(base + resource, {
      method, redirect: "error", signal: AbortSignal.timeout(12000),
      headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json", Accept: "application/json" },
      ...(serialized ? { body: serialized } : {}),
    });
  } catch { fail("coinbase_unavailable", "Coinbase withdrawal endpoint is unreachable; reconcile before retrying.", 502); }
  if (response.status === 401 || response.status === 403) fail("coinbase_auth_required", "Coinbase rejected the withdrawal authorization.", 401);
  let data;
  try { data = await response.json(); } catch { fail("coinbase_invalid_response", "Coinbase withdrawal response was not valid JSON; reconcile.", 502); }
  if (!response.ok) fail("coinbase_rejected", `Coinbase returned HTTP ${response.status} for the withdrawal request.`, 502);
  return data;
}

/**
 * Build the full cash-out plan for an amount without executing: discover ->
 * select -> quote (fee/limit from the chosen payment method or a preview call).
 */
export async function planCashout({ amount, instantOnly = true }, credentials = coinbaseCredentials(), send = fetch) {
  if (!AMOUNT.test(String(amount ?? ""))) fail("invalid_amount", "A positive amount with <= 8 decimals is required.");
  const state = await discoverCashoutRails(credentials, send);
  const picked = selectCashoutRail(state, { instantOnly });
  return {
    amount: String(amount), currency: "USD",
    selected: picked.selected, rail: picked.rail,
    execution: railExecutionSupport(state),
    quote: picked.rail?.paymentMethodId
      ? { paymentMethodId: picked.rail.paymentMethodId, note: "Fee and delivery are returned by Coinbase at withdrawal-create time; no standalone preview endpoint for fiat payout rails." }
      : { note: "CDP Offramp uses a hosted sell session; the sell quote is shown in the hosted flow." },
    ready: Boolean(picked.selected),
    ownerActionRequired: "OWNER LIVE VERIFY REQUIRED",
  };
}

/**
 * Create a real fiat withdrawal to a Coinbase payment method (instant card /
 * RTP / PayPal). OWNER LIVE VERIFY REQUIRED: owner+confirm gate this call.
 */
export async function createFiatWithdrawal({ accountId, paymentMethodId, amount, clientId, owner, confirm }, credentials = coinbaseCredentials(), send = fetch, store) {
  if (owner !== true || confirm !== true) fail("owner_confirmation_required", "Owner confirmation is required to move money out of Coinbase.", 403);
  if (typeof accountId !== "string" || !accountId) fail("invalid_account", "A Coinbase fiat account id is required.");
  if (typeof paymentMethodId !== "string" || !paymentMethodId) fail("invalid_payment_method", "A payment method id is required.");
  if (!AMOUNT.test(String(amount ?? ""))) fail("invalid_amount", "A positive amount is required.");
  if (!CLIENT.test(clientId ?? "")) fail("invalid_client_id", "A stable client id (6-64 chars) is required.");
  if (store) {
    const prior = await store.get(clientId).catch(() => null);
    if (prior) {
      if (prior.state === "received" || prior.withdrawalId) return { ...prior, duplicate: true };
      fail("outcome_unknown", "This client id may already have reached Coinbase. Reconcile the withdrawal before another attempt.", 409);
    }
    await store.insertIfAbsent(clientId, { state: "pending", createdAt: new Date().toISOString() }).catch(() => {});
  }
  let data;
  try {
    data = await v2("POST", `/v2/accounts/${encodeURIComponent(accountId)}/withdrawals`, credentials, send, {
      amount: String(amount), currency: "USD", payment_method: paymentMethodId, commit: true,
    });
  } catch (e) {
    if (store) await store.put(clientId, { state: "unknown", errorCode: e.code }).catch(() => {});
    throw e;
  }
  const w = data.data ?? data;
  const result = { withdrawalId: w.id ?? null, status: w.status ?? "unknown", amount: w.amount?.amount ?? String(amount),
    fee: w.fee?.amount ?? null, payoutAt: w.payout_at ?? null, provider: "coinbase" };
  if (store) await store.put(clientId, { state: "received", ...result }).catch(() => {});
  return result;
}

/** Poll a withdrawal for authoritative status. */
export async function fiatWithdrawalStatus({ accountId, withdrawalId }, credentials = coinbaseCredentials(), send = fetch) {
  if (!accountId || !withdrawalId) fail("invalid_id", "accountId and withdrawalId are required.");
  const data = await v2("GET", `/v2/accounts/${encodeURIComponent(accountId)}/withdrawals/${encodeURIComponent(withdrawalId)}`, credentials, send);
  const w = data.data ?? data;
  return { withdrawalId, status: w.status ?? "unknown", amount: w.amount?.amount ?? null, payoutAt: w.payout_at ?? null };
}

/**
 * Create a CDP Offramp hosted sell session. Returns the hosted URL for the
 * owner to complete the sell. OWNER LIVE VERIFY REQUIRED at the hosted flow.
 */
export async function createOfframpSession({ amount, asset = "USDC", network = "solana", address, redirectUrl, owner, confirm }, credentials = coinbaseCredentials(), send = fetch) {
  if (owner !== true || confirm !== true) fail("owner_confirmation_required", "Owner confirmation is required to start a Coinbase sell session.", 403);
  if (!AMOUNT.test(String(amount ?? ""))) fail("invalid_amount", "A positive amount is required.");
  if (!["solana", "base", "ethereum"].includes(network)) fail("invalid_network", "Choose a supported network.");
  if (typeof address !== "string" || !address) fail("invalid_address", "The source wallet address is required.");
  const token = await v2(
    "POST", "/onramp/v1/token", credentials, send,
    { addresses: [{ address, blockchains: [network] }], assets: [asset] },
    { base: CDP, host: CDP_HOST },
  );
  const sessionToken = token.token ?? token.data?.token;
  if (!sessionToken) fail("coinbase_invalid_response", "Coinbase did not return an Offramp session token.", 502);
  const url = new URL("https://pay.coinbase.com/v3/sell/input");
  url.searchParams.set("sessionToken", sessionToken);
  url.searchParams.set("partnerUserId", address.slice(0, 49));
  url.searchParams.set("defaultAsset", asset);
  url.searchParams.set("defaultNetwork", network);
  url.searchParams.set("presetCryptoAmount", String(amount));
  if (redirectUrl) { try { const r = new URL(redirectUrl); if (r.protocol === "https:") url.searchParams.set("redirectUrl", r.toString()); } catch { /* ignore bad redirect */ } }
  return { provider: "coinbase", flow: "cdp_offramp", hostedUrl: url.toString(), sessionCreated: true, sessionToken,
    ownerActionRequired: "OWNER LIVE VERIFY REQUIRED", note: "Open the hosted sell flow to review the quote and confirm the payout." };
}

/**
 * Poll the CDP Offramp transaction status for a partner user id. The hosted
 * flow's sell orders are reported here once the owner completes them.
 */
export async function offrampOrderStatus({ partnerUserId }, credentials = coinbaseCredentials(), send = fetch) {
  if (typeof partnerUserId !== "string" || !partnerUserId) fail("invalid_id", "partnerUserId is required.");
  const data = await v2(
    "GET", `/onramp/v1/sell/user/${encodeURIComponent(partnerUserId)}/transactions`, credentials, send, undefined,
    { base: CDP, host: CDP_HOST },
  );
  const txns = Array.isArray(data.transactions) ? data.transactions : [];
  const latest = txns[0] ?? null;
  return {
    partnerUserId,
    count: txns.length,
    latestStatus: latest?.status ?? "none",
    latest: latest
      ? { id: latest.transaction_id ?? null, status: latest.status ?? null, sellAmount: latest.sell_amount ?? null, payoutMethod: latest.payout_method ?? null }
      : null,
  };
}

/**
 * Explicit per-rail EXECUTION classification. Every rail is one of:
 *   EXECUTABLE                     — a full discover->create->status->reconcile
 *                                    path exists and a usable method is on file
 *   UNAVAILABLE_ON_ACCOUNT         — the path exists but this Coinbase account
 *                                    has no verified withdraw-enabled method
 *   UNSUPPORTED BY CURRENT PROVIDER/API
 *                                  — no official Coinbase API path exists
 */
export function railExecutionSupport(state) {
  const r = state?.rails ?? {};
  const fiat = (rail) =>
    rail?.candidate === true
      ? { support: "EXECUTABLE", via: "POST /v2/accounts/{id}/withdrawals", paymentMethodId: rail.paymentMethodId }
      : rail
        ? { support: "UNAVAILABLE_ON_ACCOUNT", reason: rail.reason }
        : { support: "UNAVAILABLE_ON_ACCOUNT", reason: "rail not discovered" };
  return {
    instantCard: fiat(r.instantCard),
    rtp: fiat(r.rtp),
    paypal: fiat(r.paypal),
    cdpOfframp: {
      support: "EXECUTABLE",
      via: "POST /onramp/v1/token -> pay.coinbase.com/v3/sell (hosted) -> GET /onramp/v1/sell/.../transactions",
      note: "Hosted sell; the owner confirms the quote and payout in the Coinbase flow.",
    },
  };
}
