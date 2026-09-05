import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlForwarder, createControlIntentStore, coordinateExitAll, resolveControlPriority, CONTROL_PRIORITY } from './kayjay-control.mjs';

test('owner-priority ladder: emergency > scheduled flatten > owner override > AUTO', () => {
  assert.deepEqual(CONTROL_PRIORITY, ['EMERGENCY', 'SCHEDULED_FLATTEN', 'OWNER_OVERRIDE', 'AUTO']);
  assert.equal(resolveControlPriority({ emergency: true, auto: true }).winner, 'EMERGENCY');
  assert.equal(resolveControlPriority({ scheduledFlattenDue: true, ownerOverride: true, auto: true }).winner, 'SCHEDULED_FLATTEN');
  assert.equal(resolveControlPriority({ ownerOverride: true, auto: true }).winner, 'OWNER_OVERRIDE');
  assert.equal(resolveControlPriority({ auto: true }).winner, 'AUTO');
  // A manual owner action stays admissible while AUTO is the winner.
  assert.equal(resolveControlPriority({ auto: true }).ownerActionAdmissible, true);
  // Priority resolution never changes engine mode.
  assert.equal(resolveControlPriority({ auto: true }).modeChange, false);
});

function memoryStore() {
  const map = new Map();
  return { claim(id, value) { if (map.has(id)) return false; map.set(id, value); return true; }, read: id => map.get(id), write: (id, value) => map.set(id, value) };
}
const intent = { id: 'test-intent-01', owner: true, confirm: true };
const buy = { ...intent, side: 'buy', mint: 'So11111111111111111111111111111111111111112', amountLamports: 10000, dryRun: false };
const response = body => ({ ok: true, json: async () => body });

test('JINX preview and queued owner override never call mode; duplicate never requeues', async () => {
  const calls = [];
  const forwarder = createControlForwarder({ store: memoryStore(), fetchImpl: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return response({ status: JSON.parse(options.body).dryRun ? 'dry_run' : 'queued' }); } });
  assert.equal((await forwarder.manualJinx({ ...buy, dryRun: true })).status, 'dry_run');
  const result = await forwarder.manualJinx(buy);
  assert.equal(result.status, 'queued');
  assert.equal(result.reconciled, false);
  assert.equal(result.autoModeUnchanged, true);
  assert.equal((await forwarder.manualJinx(buy)).duplicate, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([url]) => url === 'http://127.0.0.1:8794/manual-order'));
  assert.equal(calls[1][1].confirm, true);
  await assert.rejects(forwarder.manualJinx({ ...buy, amountLamports: 20000 }), /different request/);
});

test('owner confirmation required before mutation', async () => {
  let calls = 0;
  const forwarder = createControlForwarder({ store: memoryStore(), fetchImpl: async () => { calls++; return response({}); } });
  await assert.rejects(forwarder.manualJinx({ ...buy, confirm: false }), /confirmation/);
  assert.equal(calls, 0);
});

test('timeout remains unknown and cannot be automatically retried or leak authority error', async () => {
  let calls = 0;
  const forwarder = createControlForwarder({ store: memoryStore(), timeoutMs: 5, fetchImpl: async (_url, { signal }) => { calls++; return new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('secret internal error')), 100); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('secret timeout')); }); }); } });
  const result = await forwarder.manualJinx(buy);
  assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal((await forwarder.manualJinx(buy)).duplicate, true);
  assert.equal(calls, 1);
});

test('file intent store preserves duplicate prevention across instances', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kayjay-control-test-'));
  try {
    const one = createControlIntentStore(directory);
    assert.equal(one.claim(intent.id, { status: 'unknown' }), true);
    const two = createControlIntentStore(directory);
    assert.equal(two.claim(intent.id, {}), false);
    assert.equal(two.read(intent.id).status, 'unknown');
    two.write(intent.id, { status: 'queued' });
    assert.equal(one.read(intent.id).status, 'queued');
  } finally { for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file)); fs.rmdirSync(directory); }
});

test('ATLAS rejects unregistered simulator before mutation; OFF does not prevent authority-owned exit', async () => {
  const calls = [];
  let registered = false;
  const forwarder = createControlForwarder({ store: memoryStore(), fetchImpl: async (url, options) => { calls.push([url, options]); return response(url.endsWith('execution-mode') ? { mode: 'OFF', live_broker: { registered } } : { submitted: true }); } });
  assert.equal((await forwarder.exitAtlas({ ...intent, symbol: 'AAPL' })).status, 'blocked');
  assert.equal(calls.length, 1);
  registered = true;
  const result = await forwarder.exitAtlas({ ...intent, id: 'test-intent-02', symbol: 'AAPL' });
  assert.equal(result.status, 'acknowledged');
  assert.equal(result.reconciled, false);
  assert.equal(calls[2][0], 'http://127.0.0.1:8080/api/positions/AAPL/exit');
  assert.equal(calls[2][1].body, undefined);
});

test('ATLAS HTTP-200 error is unknown, never success; stop normalization supports only absolute tightening', async () => {
  const calls = [];
  const forwarder = createControlForwarder({ store: memoryStore(), fetchImpl: async url => { calls.push(url); return response(url.endsWith('execution-mode') ? { live_broker: { registered: true } } : { error: 'private authority detail' }); } });
  assert.equal((await forwarder.cancelAllAtlas(intent)).status, 'unknown');
  assert.throws(() => forwarder.tightenStopAtlas({ ...intent, symbol: 'AAPL', stopLoss: -1 }), /positive/);
  assert.throws(() => forwarder.tightenStopAtlas({ ...intent, symbol: 'AAPL', stopLoss: 10, takeProfit: 12 }), /Only absolute/);
  await forwarder.tightenStopAtlas({ ...intent, id: 'test-intent-03', symbol: 'AAPL', stopLoss: 10.25 });
  assert.equal(calls.at(-1), 'http://127.0.0.1:8080/api/positions/AAPL/protective/tighten-stop?new_stop_price=10.25');
});

function authority(log, name, failure = '') {
  return {
    capabilities: { independentEntryHold: true, authoritativeReconciliation: true },
    async holdEntries() { log.push(`${name}:hold`); return { confirmed: failure !== 'hold', modeUnchanged: true }; },
    async cancelWorkingOrders() { log.push(`${name}:cancel`); return { acknowledged: true }; },
    async listWorkingOrders() { return { complete: true, orders: [] }; },
    async listPositions() { return { complete: true, positions: [{ symbol: 'TEST' }] }; },
    async exitPosition() { log.push(`${name}:exit`); return { acknowledged: true }; },
    async reconcile() { return { confirmed: true, complete: true, positions: failure === 'reconcile' ? [{ symbol: 'TEST' }] : [], orders: [] }; },
  };
}

test('EXIT ALL preflight fails before any mutation when one required authority unsupported', async () => {
  const log = [];
  const result = await coordinateExitAll({ ...intent, venues: ['known', 'JINX'] }, { store: memoryStore(), authorities: { known: authority(log, 'known') } });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.mutated, false);
  assert.equal(result.venues[0].venue, 'JINX');
  assert.deepEqual(log, []);
});

test('EXIT ALL partial reconciliation failure retains holds and cannot report success or retry', async () => {
  const log = [];
  const options = { store: memoryStore(), authorities: { one: authority(log, 'one'), two: authority(log, 'two', 'reconcile') } };
  const input = { ...intent, venues: ['one', 'two'] };
  const result = await coordinateExitAll(input, options);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reconciled, false);
  assert.equal(result.entryHoldsRetained, true);
  assert.deepEqual(log.slice(0, 2), ['one:hold', 'two:hold']);
  assert.equal(result.venues[0].status, 'flat');
  assert.equal(result.venues[1].status, 'incomplete');
  const count = log.length;
  assert.equal((await coordinateExitAll(input, options)).duplicate, true);
  assert.equal(log.length, count);
});

test('EXIT ALL requires confirmed empty positions AND orders on every venue', async () => {
  const log = [];
  const result = await coordinateExitAll({ ...intent, venues: ['one', 'two'] }, { store: memoryStore(), authorities: { one: authority(log, 'one'), two: authority(log, 'two') } });
  assert.equal(result.status, 'complete');
  assert.equal(result.reconciled, true);
});

test('failed entry hold stops all cancel and exit submissions', async () => {
  const log = [];
  const result = await coordinateExitAll({ ...intent, venues: ['one', 'two'] }, { store: memoryStore(), authorities: { one: authority(log, 'one'), two: authority(log, 'two', 'hold') } });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(log, ['one:hold', 'two:hold']);
});

test('EXIT ALL reconciliation timeout stays incomplete with entry hold retained', async () => {
  const log = [];
  const one = authority(log, 'one');
  one.reconcile = () => new Promise(() => {});
  const result = await coordinateExitAll({ ...intent, venues: ['one'] }, { store: memoryStore(), authorities: { one }, timeoutMs: 5 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.entryHoldsRetained, true);
  assert.equal(result.reconciled, false);
});
