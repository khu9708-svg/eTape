import fs from 'node:fs';
import { createHash } from 'node:crypto';

// This journal is local runtime data. Its parent directory must already exist.
// Exclusive creation prevents separate requests/processes from replaying intent.
export function createControlIntentStore(directory) {
  const pathFor = id => `${directory}/${createHash('sha256').update(id).digest('hex')}.json`;
  return {
    claim(id, intent) {
      const file = pathFor(id);
      try { fs.writeFileSync(file, JSON.stringify(intent), { flag: 'wx', mode: 0o600, flush: true }); return true; }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    },
    read(id) { return JSON.parse(fs.readFileSync(pathFor(id), 'utf8')); },
    write(id, intent) { fs.writeFileSync(pathFor(id), JSON.stringify(intent), { mode: 0o600, flush: true }); },
  };
}

// Owner-priority execution contract. Higher wins. AUTO strategy is the floor and
// is never allowed to suppress a manual owner action — a manual ENTER/BUY/SELL/
// EXIT is always admissible while AUTO runs, and AUTO stays AUTO afterwards.
export const CONTROL_PRIORITY = ['EMERGENCY', 'SCHEDULED_FLATTEN', 'OWNER_OVERRIDE', 'AUTO'];

/**
 * Resolve which control source acts now. `context` flags which sources are
 * currently asserting. Returns { winner, order, modeChange:false } — resolving
 * priority never changes engine mode.
 */
export function resolveControlPriority(context = {}) {
  const active = CONTROL_PRIORITY.filter(level => {
    if (level === 'EMERGENCY') return context.emergency === true;
    if (level === 'SCHEDULED_FLATTEN') return context.scheduledFlattenDue === true;
    if (level === 'OWNER_OVERRIDE') return context.ownerOverride === true;
    return context.auto === true;
  });
  return {
    winner: active[0] ?? null,
    order: active,
    // A manual owner action is admissible even when AUTO is the winner.
    ownerActionAdmissible: context.ownerOverride === true || active[0] !== 'EMERGENCY',
    modeChange: false,
  };
}

export const controlCapabilities = {
  JINX: { manualOrder: true, preservesAuto: true, exitAll: false, reasons: ['No entry hold independent of mode', 'No working-order listing or cancellation endpoint', 'No authoritative venue reconciliation endpoint'] },
  ATLAS: { exitPosition: true, cancelAll: true, tightenStop: true, normalizedStops: 'partial: absolute stopLoss tightening only', exitAll: false, reasons: ['Independent entry hold and authoritative complete reconciliation not verified', 'Take-profit, trailing-stop and maximum-hold forwarding unsupported'] },
  RAPTOR15: { exitAll: false, reasons: ['Read-only scanner; no execution authority'] },
};

function requireOwner(input) {
  if (input.owner !== true || input.confirm !== true) throw new Error('Owner confirmation required');
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.id)) throw new Error('A stable intent id is required');
}

function fingerprint(input) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

async function durableIntent(store, input, run) {
  requireOwner(input);
  if (!store) throw new Error('Durable intent store required');
  const digest = fingerprint(input);
  const intent = { id: input.id, fingerprint: digest, status: 'unknown', reconciled: false };
  if (!await store.claim(input.id, intent)) {
    const prior = await store.read(input.id);
    if (prior.fingerprint !== digest) throw new Error('Intent id already used for a different request');
    return { ...prior, duplicate: true };
  }
  let result;
  try { result = await run(); }
  catch { result = { status: 'unknown', reconciled: false, reason: 'Authority request failed; verify state before any further action' }; }
  const final = { ...intent, ...result };
  // Failure to persist an acknowledgement leaves the prewritten unknown intent.
  await store.write(input.id, final);
  return final;
}

export function createControlForwarder({ store, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  async function post(url, body) {
    try {
      const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error();
      const reply = await response.json();
      if (!reply || reply.error || reply.accepted === false) throw new Error();
      return reply;
    } catch { throw new Error('Authority request unavailable or rejected; outcome must be verified'); }
  }
  async function atlas(input, route, body, normalize) {
    return durableIntent(store, { ...input, authorityRoute: route }, async () => {
      const response = await fetchImpl('http://127.0.0.1:8080/api/execution-mode', { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { status: 'blocked', reconciled: false, reason: 'Live broker readiness unavailable' };
      const mode = await response.json();
      if (mode?.error || mode?.live_broker?.registered !== true) return { status: 'blocked', reconciled: false, reason: 'Canonical live broker is not registered' };
      // No mode changes: risk-reducing actions remain the authority's decision.
      const reply = await post(`http://127.0.0.1:8080${route}`, body);
      return { ...normalize(reply), reconciled: false, modeUnchanged: true };
    });
  }
  function symbolPath(symbol) {
    if (typeof symbol !== 'string' || !/^[A-Za-z0-9._:-]{1,40}$/.test(symbol)) throw new Error('Invalid symbol');
    return encodeURIComponent(symbol);
  }
  return {
    exitAtlas(input) {
      return atlas(input, `/api/positions/${symbolPath(input.symbol)}/exit`, undefined, () => ({ status: 'acknowledged', reason: 'Submission response only; exit requires reconciliation' }));
    },
    cancelAllAtlas(input) {
      return atlas(input, '/api/emergency/cancel-all', undefined, reply => ({ status: reply.all_cancelled === true ? 'acknowledged' : 'unknown', reason: 'Verify authoritative working orders after cancellation' }));
    },
    tightenStopAtlas(input) {
      if (!Number.isFinite(input.stopLoss) || input.stopLoss <= 0) throw new Error('Absolute positive stopLoss price required');
      if (['takeProfit', 'trailingStop', 'trailingPercent', 'maxHold', 'maxHoldSeconds'].some(key => input[key] != null)) throw new Error('Only absolute stopLoss tightening is supported');
      return atlas(input, `/api/positions/${symbolPath(input.symbol)}/protective/tighten-stop?new_stop_price=${input.stopLoss}`, undefined, reply => ({ status: reply.accepted === true ? 'acknowledged' : 'unknown', reason: 'Authority stop acknowledgement; not a fill confirmation' }));
    },
    async manualJinx(input) {
      if (!['buy', 'sell'].includes(input.side)) throw new Error('Unsupported side');
      if (typeof input.mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.mint)) throw new Error('Valid mint required');
      const positive = value => Number.isSafeInteger(value) && value > 0;
      if (input.side === 'buy' && !positive(input.amountLamports)) throw new Error('Positive amountLamports required');
      if (input.side === 'sell' && !positive(input.tokenAmount) && !(positive(input.sellFractionBps) && input.sellFractionBps <= 10000)) throw new Error('Positive tokenAmount or sellFractionBps required');
      if (input.slippageBps != null && !(positive(input.slippageBps) && input.slippageBps <= 10000)) throw new Error('Invalid slippageBps');
      const body = Object.fromEntries(['id', 'side', 'mint', 'amountLamports', 'tokenAmount', 'sellFractionBps', 'slippageBps'].filter(key => input[key] != null).map(key => [key, input[key]]));
      if (input.dryRun !== false) {
        const reply = await post('http://127.0.0.1:8794/manual-order', { ...body, dryRun: true });
        return { status: reply.status === 'dry_run' ? 'dry_run' : 'unknown', reconciled: false, autoModeUnchanged: true };
      }
      return durableIntent(store, { ...input, authorityRoute: 'JINX/manual-order' }, async () => {
        const reply = await post('http://127.0.0.1:8794/manual-order', { ...body, dryRun: false, confirm: true });
        return { status: reply.status === 'queued' ? 'queued' : 'unknown', reconciled: false, autoModeUnchanged: true, reason: 'Queue acknowledgement is not execution confirmation' };
      });
    },
  };
}

const exitMethods = ['holdEntries', 'cancelWorkingOrders', 'listWorkingOrders', 'listPositions', 'exitPosition', 'reconcile'];

// Authorities implement these methods themselves. A mode switch cannot satisfy
// the entry hold contract. No fallback routes or engine state are invented here.
export async function coordinateExitAll(input, { store, authorities = {}, timeoutMs = 8000 } = {}) {
  requireOwner(input);
  const venues = Array.isArray(input.venues) ? [...new Set(input.venues)] : [];
  if (!venues.length || venues.some(name => typeof name !== 'string')) throw new Error('Explicit venue scope required');
  const unsupported = venues.flatMap(venue => {
    const authority = authorities[venue];
    const reasons = [];
    if (authority?.capabilities?.independentEntryHold !== true) reasons.push('Cannot freeze entries without changing mode');
    if (authority?.capabilities?.authoritativeReconciliation !== true) reasons.push('Complete authoritative reconciliation unavailable');
    for (const method of exitMethods) if (typeof authority?.[method] !== 'function') reasons.push(`Unsupported ${method}`);
    return reasons.length ? [{ venue, status: 'unsupported', reasons }] : [];
  });
  if (unsupported.length) return { status: 'unsupported', reconciled: false, mutated: false, venues: unsupported };
  async function bounded(operation) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Authority timeout')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  return durableIntent(store, { ...input, authorityRoute: 'EXIT-ALL' }, async () => {
    const results = [];
    // Establish every entry hold before issuing any cancel/exit.
    for (const venue of venues) {
      try {
        const hold = await bounded(() => authorities[venue].holdEntries(input.id));
        if (hold?.confirmed !== true || hold?.modeUnchanged !== true) throw new Error();
      } catch {
        return { status: 'incomplete', reconciled: false, entryHoldsRetained: true, venues: [{ venue, status: 'failed', reason: 'Entry hold not confirmed; no exits submitted' }] };
      }
    }
    for (const venue of venues) {
      const authority = authorities[venue];
      try {
        const cancelled = await bounded(() => authority.cancelWorkingOrders(input.id));
        if (cancelled?.acknowledged !== true) throw new Error();
        const orders = await bounded(() => authority.listWorkingOrders());
        const positions = await bounded(() => authority.listPositions());
        if (orders?.complete !== true || !Array.isArray(orders.orders) || orders.orders.length !== 0 || positions?.complete !== true || !Array.isArray(positions.positions)) throw new Error();
        for (const position of positions.positions) {
          const exit = await bounded(() => authority.exitPosition(position, input.id));
          if (exit?.acknowledged !== true) throw new Error();
        }
        const state = await bounded(() => authority.reconcile());
        if (state?.confirmed !== true || state?.complete !== true || !Array.isArray(state.positions) || !Array.isArray(state.orders) || state.positions.length || state.orders.length) throw new Error();
        results.push({ venue, status: 'flat', reconciled: true });
      } catch { results.push({ venue, status: 'incomplete', reconciled: false, reason: 'Exit or reconciliation unconfirmed; entry hold retained' }); }
    }
    const complete = results.every(result => result.reconciled);
    return { status: complete ? 'complete' : 'incomplete', reconciled: complete, entryHoldsRetained: true, venues: results };
  });
}
