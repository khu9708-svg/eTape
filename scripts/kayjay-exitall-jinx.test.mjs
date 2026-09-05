import test from 'node:test';
import assert from 'node:assert/strict';
import { createJinxExitAllAuthority } from './kayjay-exitall-jinx.mjs';

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

test('adapter maps worker capabilities and hold/reconcile responses faithfully', async () => {
  stub({
    '/exit-all/capabilities': { independentEntryHold: true, authoritativeReconciliation: true },
    '/exit-all/hold': { confirmed: true, modeUnchanged: true, desiredStateUnchanged: true },
    '/exit-all/reconcile': { confirmed: true, complete: true, positions: [], orders: [] },
  });
  const a = await createJinxExitAllAuthority({ intentId: 'x' });
  assert.deepEqual(a.capabilities, { independentEntryHold: true, authoritativeReconciliation: true });
  assert.deepEqual(await a.holdEntries(), { confirmed: true, modeUnchanged: true });
  assert.equal((await a.reconcile()).confirmed, true);
});

test('a hold that changed mode is reported as not modeUnchanged', async () => {
  stub({
    '/exit-all/capabilities': { independentEntryHold: true, authoritativeReconciliation: true },
    '/exit-all/hold': { confirmed: true, modeUnchanged: false, desiredStateUnchanged: true },
  });
  const a = await createJinxExitAllAuthority();
  assert.deepEqual(await a.holdEntries(), { confirmed: true, modeUnchanged: false });
});

test('an unreachable worker yields non-confirming results, never optimistic ones', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const a = await createJinxExitAllAuthority();
  assert.equal(a.capabilities.independentEntryHold, false);
  assert.equal((await a.holdEntries()).confirmed, false);
  assert.equal((await a.reconcile()).confirmed, false);
  assert.equal((await a.listPositions()).complete, false);
});
