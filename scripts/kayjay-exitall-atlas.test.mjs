import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlasExitAllAuthority } from './kayjay-exitall-atlas.mjs';

const realFetch = globalThis.fetch;
function stub(routes) {
  globalThis.fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    const body = typeof routes[path] === 'function' ? routes[path](opts) : routes[path];
    return { ok: true, status: 200, json: async () => body };
  };
}
test.afterEach(() => { globalThis.fetch = realFetch; });

test('adapter maps ATLAS capabilities and a mode-preserving hold', async () => {
  stub({
    '/api/exit-all/capabilities': { independent_entry_hold: true, authoritative_reconciliation: true },
    '/api/exit-all/hold': { confirmed: true, mode_unchanged: true, mode: 'AUTO' },
    '/api/exit-all/reconcile': { confirmed: true, complete: true, positions: [], orders: [] },
  });
  const a = await createAtlasExitAllAuthority();
  assert.deepEqual(a.capabilities, { independentEntryHold: true, authoritativeReconciliation: true });
  assert.deepEqual(await a.holdEntries(), { confirmed: true, modeUnchanged: true });
  assert.equal((await a.reconcile()).confirmed, true);
});

test('a hold reported as mode-changing surfaces modeUnchanged:false', async () => {
  stub({
    '/api/exit-all/capabilities': { independent_entry_hold: true, authoritative_reconciliation: true },
    '/api/exit-all/hold': { confirmed: true, mode_unchanged: false, mode: 'MANUAL' },
  });
  const a = await createAtlasExitAllAuthority();
  assert.deepEqual(await a.holdEntries(), { confirmed: true, modeUnchanged: false });
});

test('an unreachable ATLAS dashboard yields non-confirming results', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const a = await createAtlasExitAllAuthority();
  assert.equal(a.capabilities.independentEntryHold, false);
  assert.equal((await a.holdEntries()).confirmed, false);
  assert.equal((await a.reconcile()).confirmed, false);
  assert.equal((await a.listPositions()).complete, false);
});

test('exitPosition uppercases the symbol and routes to the ATLAS exit endpoint', async () => {
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(new URL(url).pathname); return { ok: true, status: 200, json: async () => ({}) }; };
  const a = await createAtlasExitAllAuthority();
  const r = await a.exitPosition({ symbol: 'aapl' });
  assert.equal(r.acknowledged, true);
  assert.ok(calls.some((p) => p === '/api/positions/AAPL/exit'));
});
