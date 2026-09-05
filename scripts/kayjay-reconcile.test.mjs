import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVenueReconciler, normalizeVenueState, NORMALIZED_STATES, ReconcileError } from './kayjay-reconcile.mjs';

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kayjay-recon-'));
  return { dir, file: path.join(dir, 'reconcile.json') };
}

test('normalizeVenueState maps venue vocabularies onto the shared set', () => {
  assert.equal(normalizeVenueState('COINBASE', 'FILLED'), 'filled');
  assert.equal(normalizeVenueState('ATLAS', 'cancelled'), 'canceled');
  assert.equal(normalizeVenueState('JINX', 'dry_run'), 'acknowledged');
  assert.equal(normalizeVenueState('JINX', 'not_found'), 'needs_reconciliation');
  assert.equal(normalizeVenueState('COINBASE', 'weird-status'), 'unknown');
  for (const s of ['filled', 'canceled', 'rejected']) assert.ok(NORMALIZED_STATES.includes(s));
});

test('record persists legs, is restart-safe, and rejects a changed provider ref', () => {
  const { dir, file } = scratch();
  try {
    const r1 = createVenueReconciler({ file });
    r1.record('kj-exit-0001', 'JINX', { providerRef: 'sig-1', state: 'submitted' });
    r1.record('kj-exit-0001', 'ATLAS', { providerRef: 'ord-9', state: 'open' });
    // a fresh reconciler instance (process restart) sees the same intent
    const r2 = createVenueReconciler({ file });
    const intent = r2.get('kj-exit-0001');
    assert.equal(intent.legs.JINX.providerRef, 'sig-1');
    assert.equal(intent.legs.ATLAS.state, 'acknowledged');
    assert.throws(() => r2.record('kj-exit-0001', 'JINX', { providerRef: 'sig-2' }), (e) => e instanceof ReconcileError && e.code === 'ref_conflict');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile does an authoritative per-venue lookup; an unreachable venue is needs_reconciliation, not a retry', async () => {
  const { dir, file } = scratch();
  try {
    const calls = [];
    const r = createVenueReconciler({
      file,
      lookups: {
        JINX: async (ref) => { calls.push(['JINX', ref]); return { state: 'filled' }; },
        ATLAS: async () => { throw new Error('ECONNREFUSED'); },
        COINBASE: async () => ({ state: 'CANCELLED' }),
      },
    });
    r.record('kj-exit-x1', 'JINX', { providerRef: 'sig-1' });
    r.record('kj-exit-x1', 'ATLAS', { providerRef: 'ord-9' });
    r.record('kj-exit-x1', 'COINBASE', { providerRef: 'cb-1' });
    const out = await r.reconcile('kj-exit-x1');
    assert.equal(out.legs.JINX.state, 'filled');
    assert.equal(out.legs.ATLAS.state, 'needs_reconciliation');
    assert.equal(out.legs.COINBASE.state, 'canceled');
    assert.equal(out.allReconciled, false); // ATLAS not terminal
    assert.equal(out.needsAttention, true);
    assert.deepEqual(calls, [['JINX', 'sig-1']]);
    // the persisted state reflects the refreshed leg states
    assert.equal(r.get('kj-exit-x1').legs.ATLAS.state, 'needs_reconciliation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('allReconciled is true only when every leg is terminal', async () => {
  const { dir, file } = scratch();
  try {
    const r = createVenueReconciler({
      file,
      lookups: { JINX: async () => ({ state: 'filled' }), ATLAS: async () => ({ state: 'canceled' }) },
    });
    r.record('kj-done-01', 'JINX', { providerRef: 's' });
    r.record('kj-done-01', 'ATLAS', { providerRef: 'o' });
    const out = await r.reconcile('kj-done-01');
    assert.equal(out.allReconciled, true);
    assert.equal(out.needsAttention, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a venue with no wired lookup is needs_reconciliation, never assumed', async () => {
  const { dir, file } = scratch();
  try {
    const r = createVenueReconciler({ file, lookups: {} });
    r.record('kj-none-1', 'COINBASE', { providerRef: 'cb' });
    const out = await r.reconcile('kj-none-1');
    assert.equal(out.legs.COINBASE.state, 'needs_reconciliation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
