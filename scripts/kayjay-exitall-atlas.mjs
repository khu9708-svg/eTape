// eTape-side adapter: presents the ATLAS dashboard's /api/exit-all/* endpoints
// as the authority object coordinateExitAll() consumes. 1:1 route mapping; a
// transport failure yields a non-confirming result, never an optimistic one.
const ATLAS = "http://127.0.0.1:8080";

async function call(pathname, { method = "GET", body, timeoutMs = 8000 } = {}) {
  const response = await fetch(ATLAS + pathname, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`ATLAS ${pathname} -> HTTP ${response.status}`);
  return response.json();
}

export async function createAtlasExitAllAuthority({ intentId } = {}) {
  let capabilities;
  try {
    const c = await call("/api/exit-all/capabilities");
    capabilities = {
      independentEntryHold: c.independent_entry_hold === true,
      authoritativeReconciliation: c.authoritative_reconciliation === true,
    };
  } catch {
    capabilities = { independentEntryHold: false, authoritativeReconciliation: false };
  }

  return {
    capabilities,

    async holdEntries(_id = intentId) {
      try {
        const r = await call("/api/exit-all/hold", { method: "POST" });
        return { confirmed: r.confirmed === true, modeUnchanged: r.mode_unchanged === true };
      } catch { return { confirmed: false, modeUnchanged: true }; }
    },

    async releaseEntries() {
      try { return await call("/api/exit-all/release", { method: "POST" }); }
      catch { return { released: false }; }
    },

    async cancelWorkingOrders(_id = intentId) {
      try {
        const r = await call("/api/emergency/cancel-all", { method: "POST" });
        return { acknowledged: r.all_cancelled === true };
      } catch { return { acknowledged: false }; }
    },

    async listWorkingOrders() {
      try {
        const r = await call("/api/exit-all/working-orders");
        return { complete: r.complete === true, orders: Array.isArray(r.orders) ? r.orders : [] };
      } catch { return { complete: false, orders: [] }; }
    },

    async listPositions() {
      try {
        const r = await call("/api/exit-all/positions");
        return { complete: r.complete === true, positions: Array.isArray(r.positions) ? r.positions : [] };
      } catch { return { complete: false, positions: [] }; }
    },

    async exitPosition(position, _id = intentId) {
      const symbol = position?.symbol;
      if (!symbol) return { acknowledged: false, reason: "position symbol missing" };
      try {
        const r = await call(`/api/positions/${encodeURIComponent(String(symbol).toUpperCase())}/exit`, { method: "POST" });
        return { acknowledged: !r.error };
      } catch { return { acknowledged: false }; }
    },

    async reconcile() {
      try {
        const r = await call("/api/exit-all/reconcile");
        return {
          confirmed: r.confirmed === true,
          complete: r.complete === true,
          positions: Array.isArray(r.positions) ? r.positions : [{ symbol: "unknown" }],
          orders: Array.isArray(r.orders) ? r.orders : [{ client_order_id: "unknown" }],
        };
      } catch { return { confirmed: false, complete: false, positions: [{ symbol: "unreachable" }], orders: [] }; }
    },
  };
}
