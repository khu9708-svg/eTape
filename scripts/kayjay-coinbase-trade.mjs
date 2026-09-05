// Coinbase Advanced Trade execution, wired THROUGH the KAYJAY mode/risk
// authority. Coinbase is not a second engine: Face -> KAYJAY authority ->
// this adapter -> Coinbase. Order submission is a money-moving action and is
// OWNER LIVE VERIFY REQUIRED; this module is fully wired, idempotent and
// reconciled, but the final live submit is an explicit owner action.
//
// Contracts: docs.cdp.coinbase.com/advanced-trade/reference
//   POST /api/v3/brokerage/orders
//   POST /api/v3/brokerage/orders/batch_cancel
//   GET  /api/v3/brokerage/orders/historical/{order_id}
import { coinbaseCredentials, coinbaseJwt } from "./kayjay-coinbase.mjs";

const HOST = "api.coinbase.com";
const BASE = "/api/v3/brokerage";

export class TradeError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = "TradeError"; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new TradeError(code, message, status); };

const CLIENT_ID = /^[a-zA-Z0-9_-]{6,64}$/;
const PRODUCT = /^[A-Z0-9]{1,10}-[A-Z0-9]{1,10}$/;
const DECIMAL = /^\d{1,12}(\.\d{1,10})?$/;

// Coinbase order status -> normalized KAYJAY reconciliation state.
const STATUS = {
  PENDING: "submitted", OPEN: "acknowledged", QUEUED: "acknowledged",
  FILLED: "filled", CANCELLED: "canceled", CANCELED: "canceled",
  EXPIRED: "canceled", FAILED: "rejected", REJECTED: "rejected",
  UNKNOWN_ORDER_STATUS: "unknown",
};
const normalizeStatus = s => STATUS[String(s || "").toUpperCase()] || "unknown";

export function createCoinbaseTrader({ credentials = coinbaseCredentials(), store, send = fetch, timeoutMs = 10000 } = {}) {
  if (!store?.get || !store?.insertIfAbsent || !store?.put) fail("state_required", "Durable trade-intent state is required.", 503);

  function auth(method, resource) {
    try { return coinbaseJwt(method, resource, credentials, undefined, HOST); }
    catch { fail("coinbase_auth_required", "Coinbase trading credentials are UNSET or invalid.", 503); }
  }
  async function call(method, resource, body) {
    const jwt = auth(method, resource);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let response;
    try {
      response = await send("https://" + HOST + resource, {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: "Bearer " + jwt, "Content-Type": "application/json", Accept: "application/json" },
        ...(serialized ? { body: serialized } : {}),
      });
    } catch { fail("coinbase_unavailable", "Coinbase trading endpoint is unreachable; verify order state before retrying.", 502); }
    if (response.status === 401 || response.status === 403) fail("coinbase_auth_required", "Coinbase rejected trading authorization.", 401);
    let data;
    try { data = await response.json(); } catch { fail("coinbase_invalid_response", "Coinbase trading response was not valid JSON; reconcile before retrying.", 502); }
    if (!response.ok) fail("coinbase_rejected", `Coinbase returned HTTP ${response.status} for the trade request.`, 502);
    return data;
  }

  function validateOrder(o) {
    if (!o || !CLIENT_ID.test(o.clientOrderId ?? "")) fail("invalid_client_id", "A stable client order id (6-64 chars) is required.");
    if (!PRODUCT.test(o.productId ?? "")) fail("invalid_product", "A valid product id such as BTC-USD is required.");
    if (!["BUY", "SELL"].includes(o.side)) fail("invalid_side", "side must be BUY or SELL.");
    const type = o.type ?? "MARKET";
    if (!["MARKET", "LIMIT"].includes(type)) fail("invalid_type", "type must be MARKET or LIMIT.");
    const cfg = {};
    if (type === "MARKET") {
      if (o.side === "BUY") {
        if (!DECIMAL.test(o.quoteSize ?? "")) fail("invalid_size", "A market BUY needs quoteSize (USD).");
        cfg.market_market_ioc = { quote_size: o.quoteSize };
      } else {
        if (!DECIMAL.test(o.baseSize ?? "")) fail("invalid_size", "A market SELL needs baseSize.");
        cfg.market_market_ioc = { base_size: o.baseSize };
      }
    } else {
      if (!DECIMAL.test(o.baseSize ?? "")) fail("invalid_size", "A limit order needs baseSize.");
      if (!DECIMAL.test(o.limitPrice ?? "")) fail("invalid_price", "A limit order needs limitPrice.");
      cfg.limit_limit_gtc = { base_size: o.baseSize, limit_price: o.limitPrice, post_only: o.postOnly === true };
    }
    return { client_order_id: o.clientOrderId, product_id: o.productId, side: o.side, order_configuration: cfg };
  }

  async function reconcile(clientOrderId) {
    if (!CLIENT_ID.test(clientOrderId ?? "")) fail("invalid_client_id", "A client order id is required.");
    const record = await store.get(clientOrderId);
    if (!record) return { clientOrderId, state: "not_found", retryAllowed: true, message: "No prior submission recorded for this id." };
    if (!record.coinbaseOrderId) return { clientOrderId, state: record.state === "received" ? "unknown" : record.state, retryAllowed: false, message: "No Coinbase order id was captured. Check Coinbase order history before another attempt." };
    const data = await call("GET", `${BASE}/orders/historical/${encodeURIComponent(record.coinbaseOrderId)}`);
    const order = data.order ?? data;
    const state = normalizeStatus(order.status);
    await store.put(clientOrderId, { ...record, lastReconciledAt: new Date().toISOString(), state, coinbaseStatus: order.status });
    return { clientOrderId, coinbaseOrderId: record.coinbaseOrderId, state, retryAllowed: false,
      filledSize: order.filled_size ?? null, averageFilledPrice: order.average_filled_price ?? null, rejectReason: order.reject_reason ?? null };
  }

  return {
    reconcile,
    async getOrder(coinbaseOrderId) {
      if (typeof coinbaseOrderId !== "string" || !coinbaseOrderId) fail("invalid_order_id", "A Coinbase order id is required.");
      const data = await call("GET", `${BASE}/orders/historical/${encodeURIComponent(coinbaseOrderId)}`);
      const order = data.order ?? data;
      return { coinbaseOrderId, state: normalizeStatus(order.status), coinbaseStatus: order.status ?? null,
        filledSize: order.filled_size ?? null, averageFilledPrice: order.average_filled_price ?? null };
    },
    async cancel(coinbaseOrderId) {
      if (typeof coinbaseOrderId !== "string" || !coinbaseOrderId) fail("invalid_order_id", "A Coinbase order id is required.");
      const data = await call("POST", `${BASE}/orders/batch_cancel`, { order_ids: [coinbaseOrderId] });
      const result = Array.isArray(data.results) ? data.results[0] : null;
      return { coinbaseOrderId, canceled: result?.success === true, failureReason: result?.failure_reason ?? null };
    },
    /**
     * Submit a Coinbase order. Requires mode !== "OFF" and owner confirmation.
     * Idempotent on clientOrderId. Ambiguous outcome -> stored unknown, never
     * a blind resubmit. THIS PLACES A REAL ORDER: owner-invoked only.
     */
    async submit(order, { mode, owner, confirm } = {}) {
      if (mode === "OFF") fail("mode_off", "Coinbase execution is OFF. Set MANUAL or AUTO first.", 409);
      if (!["MANUAL", "AUTO"].includes(mode)) fail("mode_unknown", "KAYJAY execution mode is unknown; refusing to trade.", 409);
      if (owner !== true || confirm !== true) fail("owner_confirmation_required", "Owner confirmation is required to place a Coinbase order.", 403);
      const body = validateOrder(order);
      const key = order.clientOrderId;
      const prior = await store.get(key);
      if (prior) {
        if (prior.fingerprint && prior.fingerprint !== JSON.stringify(body)) fail("intent_conflict", "This client order id was already used for different order details.", 409);
        if (prior.state === "received" || prior.coinbaseOrderId) return { ...prior, duplicate: true };
        fail("outcome_unknown", "This client order id may already have reached Coinbase. Reconcile before another attempt.", 409);
      }
      const record = { clientOrderId: key, fingerprint: JSON.stringify(body), state: "pending", mode, createdAt: new Date().toISOString() };
      if (!await store.insertIfAbsent(key, record)) fail("intent_in_progress", "This client order id is already being submitted.", 409);
      let data;
      try {
        data = await call("POST", `${BASE}/orders`, body);
      } catch (e) {
        await store.put(key, { ...record, state: "unknown", errorCode: e instanceof TradeError ? e.code : "state_unavailable" }).catch(() => {});
        throw e;
      }
      const success = data.success === true || data.success_response;
      const resp = data.success_response ?? data.order ?? {};
      const coinbaseOrderId = resp.order_id ?? data.order_id ?? null;
      if (!success && !coinbaseOrderId) {
        const reason = data.error_response?.message ?? data.failure_reason ?? "Coinbase did not accept the order.";
        await store.put(key, { ...record, state: "rejected", rejectReason: reason });
        return { clientOrderId: key, state: "rejected", rejectReason: reason };
      }
      const final = { ...record, state: "received", coinbaseOrderId, submittedAt: new Date().toISOString() };
      await store.put(key, final).catch(() => {});
      return { clientOrderId: key, coinbaseOrderId, state: "submitted", mode,
        note: "Order reached Coinbase. Reconcile for fill status; submission is not a fill." };
    },
  };
}
