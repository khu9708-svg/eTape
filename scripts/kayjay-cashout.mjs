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

// Documented payment-method type -> the cash-out rail it can serve.
const RAIL_FOR_TYPE = {
  DEBIT_CARD: "instantCard",
  FIAT_WALLET: "cdpOfframp",
  PAYPAL_ACCOUNT: "paypal",
  PAYPAL: "paypal",
  RTP: "rtp",
  ACH_BANK_ACCOUNT: "ach",
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
  const candidates = methods.filter(m => RAIL_FOR_TYPE[m.type] === rail && m.currency === "USD");
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
