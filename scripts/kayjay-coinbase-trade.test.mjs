import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createCoinbaseTrader, TradeError } from './kayjay-coinbase-trade.mjs';

const creds = () => ({ name: 'test', secret: generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64') });
const ok = body => ({ ok: true, status: 200, json: async () => body });
function memoryStore() { const m = new Map(); return { get: async k => m.get(k), insertIfAbsent: async (k, v) => { if (m.has(k)) return false; m.set(k, v); return true; }, put: async (k, v) => m.set(k, v) }; }
const trader = (send, store = memoryStore()) => createCoinbaseTrader({ credentials: creds(), store, send });
const order = { clientOrderId: 'kj-order-0001', productId: 'BTC-USD', side: 'BUY', type: 'MARKET', quoteSize: '25.00' };
const owned = { mode: 'MANUAL', owner: true, confirm: true };

test('OFF mode and missing owner confirmation both refuse to trade before any call', async () => {
  let calls = 0;
  const t = trader(async () => { calls++; return ok({}); });
  await assert.rejects(t.submit(order, { mode: 'OFF', owner: true, confirm: true }), (e) => e.code === 'mode_off');
  await assert.rejects(t.submit(order, { mode: 'MANUAL', owner: false, confirm: false }), (e) => e.code === 'owner_confirmation_required');
  assert.equal(calls, 0);
});

test('a successful submit stores the coinbase order id and is idempotent on client id', async () => {
  let calls = 0;
  const store = memoryStore();
  const t = trader(async () => { calls++; return ok({ success: true, success_response: { order_id: 'cb-1' } }); }, store);
  const first = await t.submit(order, owned);
  assert.equal(first.state, 'submitted');
  assert.equal(first.coinbaseOrderId, 'cb-1');
  const dup = await t.submit(order, owned);
  assert.equal(dup.duplicate, true);
  assert.equal(calls, 1);
});

test('changed order details on the same client id are rejected', async () => {
  const store = memoryStore();
  const t = trader(async () => ok({ success: true, success_response: { order_id: 'cb-2' } }), store);
  await t.submit(order, owned);
  await assert.rejects(t.submit({ ...order, quoteSize: '30.00' }, owned), (e) => e.code === 'intent_conflict');
});

test('ambiguous network failure becomes unknown and cannot blindly resubmit', async () => {
  const store = memoryStore();
  let calls = 0;
  const t1 = trader(async () => { calls++; throw new Error('socket hang up'); }, store);
  await assert.rejects(t1.submit(order, owned), (e) => e instanceof TradeError && e.code === 'coinbase_unavailable');
  const t2 = trader(async () => { calls++; return ok({ success: true, success_response: { order_id: 'cb-late' } }); }, store);
  await assert.rejects(t2.submit(order, owned), (e) => e.code === 'outcome_unknown');
  assert.equal(calls, 1);
});

test('an explicit Coinbase rejection is stored as rejected with the reason', async () => {
  const t = trader(async () => ok({ success: false, error_response: { message: 'INSUFFICIENT_FUND' } }));
  const result = await t.submit(order, owned);
  assert.equal(result.state, 'rejected');
  assert.match(result.rejectReason, /INSUFFICIENT_FUND/);
});

test('reconcile queries Coinbase and normalizes the status', async () => {
  const store = memoryStore();
  const t = trader(async (url) => url.includes('/orders/historical/')
    ? ok({ order: { status: 'FILLED', filled_size: '0.0004', average_filled_price: '62500' } })
    : ok({ success: true, success_response: { order_id: 'cb-3' } }), store);
  await t.submit(order, owned);
  const state = await t.reconcile(order.clientOrderId);
  assert.equal(state.state, 'filled');
  assert.equal(state.filledSize, '0.0004');
  assert.equal(state.retryAllowed, false);
});

test('cancel maps batch_cancel results', async () => {
  const t = trader(async () => ok({ results: [{ success: true }] }));
  assert.equal((await t.cancel('cb-9')).canceled, true);
});

test('market BUY without quoteSize and limit without price are rejected', async () => {
  const t = trader(async () => ok({}));
  await assert.rejects(t.submit({ ...order, quoteSize: undefined }, owned), (e) => e.code === 'invalid_size');
  await assert.rejects(t.submit({ clientOrderId: 'kj-order-0002', productId: 'BTC-USD', side: 'SELL', type: 'LIMIT', baseSize: '0.001' }, owned), (e) => e.code === 'invalid_price');
});
