import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRiskContract, translateForVenue, RiskError } from './kayjay-risk.mjs';

test('an empty or all-invalid contract is rejected', () => {
  assert.throws(() => normalizeRiskContract({}), (e) => e instanceof RiskError && e.code === 'empty');
  assert.throws(() => normalizeRiskContract({ stopLoss: -1 }), (e) => e.code === 'stop_loss');
  assert.throws(() => normalizeRiskContract({ trailingStop: 5, trailingPercent: 2 }), (e) => e.code === 'trailing_conflict');
});

test('a full contract normalizes and keeps reduceOnly', () => {
  const c = normalizeRiskContract({ stopLoss: 100, takeProfit: 120, maxHoldSeconds: 3600, breakEven: true, reduceOnly: true });
  assert.equal(c.stopLoss, 100);
  assert.equal(c.breakEven, true);
  assert.equal(c.reduceOnly, true);
});

test('ATLAS supports absolute stop tighten only and reports the rest unsupported', () => {
  const t = translateForVenue({ stopLoss: 95, takeProfit: 110, trailingPercent: 3, maxHoldSeconds: 600 }, 'ATLAS');
  assert.ok(t.supported.stopLoss);
  assert.equal(t.venueOrder.route, 'protective/tighten-stop');
  assert.equal(t.venueOrder.new_stop_price, 95);
  const fields = t.unsupported.map(u => u.field).sort();
  assert.deepEqual(fields, ['maxHoldSeconds', 'takeProfit', 'trailingPercent']);
});

test('JINX forwards no protective orders and reports everything unsupported', () => {
  const t = translateForVenue({ stopLoss: 1, takeProfit: 2 }, 'JINX');
  assert.equal(t.venueOrder, null);
  assert.equal(t.unsupported.length, 2);
});

test('Coinbase maps stop-loss and take-profit into a bracket, trailing unsupported', () => {
  const t = translateForVenue({ stopLoss: 60000, takeProfit: 70000, trailingStop: 500 }, 'COINBASE');
  assert.equal(t.venueOrder.type, 'bracket');
  assert.equal(t.venueOrder.stop_trigger_price, '60000');
  assert.equal(t.venueOrder.limit_price, '70000');
  assert.equal(t.unsupported[0].field, 'trailingStop');
});

test('an unknown venue is rejected, not silently ignored', () => {
  assert.throws(() => translateForVenue({ stopLoss: 1 }, 'KRAKEN'), (e) => e.code === 'unknown_venue');
});
