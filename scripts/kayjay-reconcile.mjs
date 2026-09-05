// Unified multi-venue reconciliation for KAYJAY.
//
// One normalized state vocabulary across JINX, ATLAS and Coinbase. Every
// mutating action records an intent (stable id, persisted, restart-safe);
// reconcile() performs an AUTHORITATIVE per-venue lookup and never guesses:
// an ambiguous network/timeout outcome becomes `needs_reconciliation`, never
// a blind retry. A global "reconciled" is reported only when every requested
// venue reaches a terminal state.
import fs from "node:fs";

export const NORMALIZED_STATES = Object.freeze([
  "submitted",
  "acknowledged",
  "partially_filled",
  "filled",
  "canceled",
  "rejected",
  "unknown",
  "needs_reconciliation",
]);

const TERMINAL = new Set(["filled", "canceled", "rejected"]);
const AMBIGUOUS = new Set(["submitted", "acknowledged", "partially_filled", "unknown"]);

export class ReconcileError extends Error {
  constructor(code, message) { super(message); this.name = "ReconcileError"; this.code = code; }
}
const ID = /^[a-zA-Z0-9_:-]{6,128}$/;

// Map each venue's own status strings onto the normalized vocabulary.
export function normalizeVenueState(venue, raw) {
  const s = String(raw ?? "").toLowerCase();
  const common = {
    submitted: "submitted", pending: "submitted", open: "acknowledged", queued: "acknowledged",
    acknowledged: "acknowledged", partially_filled: "partially_filled", partial: "partially_filled",
    filled: "filled", done: "filled", closed: "filled",
    canceled: "canceled", cancelled: "canceled", expired: "canceled",
    rejected: "rejected", failed: "rejected", error: "rejected",
    unknown: "unknown", not_found: "needs_reconciliation",
  };
  if (common[s]) return common[s];
  if (venue === "JINX" && s === "dry_run") return "acknowledged";
  return "unknown";
}

export function createVenueReconciler({ file, lookups = {} } = {}) {
  if (typeof file !== "string" || !file) throw new ReconcileError("no_store", "A persistent reconcile-state file path is required.");

  function readAll() {
    try { const v = JSON.parse(fs.readFileSync(file, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
    catch (e) { if (e.code === "ENOENT") return {}; throw new ReconcileError("state_unreadable", "Reconcile state cannot be read safely."); }
  }
  function writeAll(state) {
    const tmp = `${file}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    /**
     * Record (or merge) an intent leg. Restart-safe: a re-record with the same
     * (intentId, venue) and a different providerRef is rejected as a conflict,
     * never silently overwritten.
     */
    record(intentId, venue, { providerRef = null, state = "submitted" } = {}) {
      if (!ID.test(intentId ?? "")) throw new ReconcileError("bad_id", "A stable intent id (6-128 chars) is required.");
      if (!["JINX", "ATLAS", "COINBASE"].includes(venue)) throw new ReconcileError("bad_venue", `Unknown venue: ${venue}`);
      const normalized = NORMALIZED_STATES.includes(state) ? state : normalizeVenueState(venue, state);
      const all = readAll();
      const intent = all[intentId] || { intentId, createdAt: new Date().toISOString(), legs: {} };
      const prior = intent.legs[venue];
      if (prior && prior.providerRef && providerRef && prior.providerRef !== providerRef) {
        throw new ReconcileError("ref_conflict", `intent ${intentId} / ${venue} already bound to a different provider reference`);
      }
      intent.legs[venue] = {
        providerRef: providerRef ?? prior?.providerRef ?? null,
        state: normalized,
        updatedAt: new Date().toISOString(),
      };
      all[intentId] = intent;
      writeAll(all);
      return intent;
    },

    get(intentId) {
      return readAll()[intentId] ?? null;
    },

    /**
     * Authoritatively reconcile every leg of an intent. For each venue, calls
     * lookups[venue](providerRef) -> { state } (or throws). A throw or a missing
     * lookup yields `needs_reconciliation` for that leg — never a retry, never
     * an assumed outcome. Persists the refreshed states.
     */
    async reconcile(intentId) {
      if (!ID.test(intentId ?? "")) throw new ReconcileError("bad_id", "A stable intent id is required.");
      const all = readAll();
      const intent = all[intentId];
      if (!intent) throw new ReconcileError("not_found", "No such intent.");
      const results = {};
      for (const [venue, leg] of Object.entries(intent.legs)) {
        const lookup = lookups[venue];
        if (typeof lookup !== "function") {
          results[venue] = { state: "needs_reconciliation", reason: "no authoritative lookup wired for this venue" };
          continue;
        }
        try {
          const found = await lookup(leg.providerRef);
          const state = NORMALIZED_STATES.includes(found?.state)
            ? found.state
            : normalizeVenueState(venue, found?.state);
          results[venue] = { state, providerRef: leg.providerRef, detail: found?.detail ?? null };
        } catch (error) {
          results[venue] = {
            state: "needs_reconciliation",
            reason: "authoritative lookup failed; verify at the venue before any further action",
          };
        }
      }
      for (const [venue, r] of Object.entries(results)) {
        intent.legs[venue] = { ...intent.legs[venue], state: r.state, reconciledAt: new Date().toISOString() };
      }
      intent.lastReconciledAt = new Date().toISOString();
      all[intentId] = intent;
      writeAll(all);

      const states = Object.values(results).map((r) => r.state);
      return {
        intentId,
        legs: results,
        allReconciled: states.length > 0 && states.every((s) => TERMINAL.has(s)),
        needsAttention: states.some((s) => s === "needs_reconciliation" || AMBIGUOUS.has(s)),
      };
    },
  };
}
