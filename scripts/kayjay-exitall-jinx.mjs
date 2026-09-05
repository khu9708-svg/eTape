// eTape-side adapter: presents the JINX worker's /exit-all/* endpoints as the
// authority object the coordinateExitAll() coordinator (kayjay-control.mjs)
// consumes. Every method maps 1:1 to a worker route; a transport failure yields
// a non-confirming result, never an optimistic one.
const JINX = "http://127.0.0.1:8794";

async function call(pathname, { method = "POST", body, timeoutMs = 8000 } = {}) {
  const response = await fetch(JINX + pathname, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`JINX ${pathname} -> HTTP ${response.status}`);
  return response.json();
}

export async function createJinxExitAllAuthority({ intentId } = {}) {
  let capabilities;
  try { capabilities = await call("/exit-all/capabilities", { method: "GET" }); }
  catch { capabilities = { independentEntryHold: false, authoritativeReconciliation: false }; }

  return {
    capabilities,

    async holdEntries(id = intentId) {
      try {
        const r = await call("/exit-all/hold", { body: { owner: true, intentId: id } });
        return { confirmed: r.confirmed === true, modeUnchanged: r.modeUnchanged === true && r.desiredStateUnchanged === true };
      } catch { return { confirmed: false, modeUnchanged: true }; }
    },

    async cancelWorkingOrders(id = intentId) {
      try {
        const r = await call("/exit-all/cancel-working-orders", { body: { owner: true, intentId: id } });
        return { acknowledged: r.acknowledged === true };
      } catch { return { acknowledged: false }; }
    },

    async listWorkingOrders() {
      try {
        const r = await call("/exit-all/working-orders", { method: "GET" });
        return { complete: r.complete === true, orders: Array.isArray(r.orders) ? r.orders : [] };
      } catch { return { complete: false, orders: [] }; }
    },

    async listPositions() {
      try {
        const r = await call("/exit-all/positions", { method: "GET" });
        return { complete: r.complete === true, positions: Array.isArray(r.positions) ? r.positions : [] };
      } catch { return { complete: false, positions: [] }; }
    },

    async exitPosition(position, id = intentId) {
      try {
        const r = await call("/exit-all/exit-position", { body: { owner: true, position, intentId: id } });
        return { acknowledged: r.acknowledged === true };
      } catch { return { acknowledged: false }; }
    },

    async reconcile() {
      try {
        const r = await call("/exit-all/reconcile", { method: "GET" });
        return {
          confirmed: r.confirmed === true,
          complete: r.complete === true,
          positions: Array.isArray(r.positions) ? r.positions : [{ mint: "unknown" }],
          orders: Array.isArray(r.orders) ? r.orders : [{ id: "unknown" }],
        };
      } catch { return { confirmed: false, complete: false, positions: [{ mint: "unreachable" }], orders: [] }; }
    },

    async releaseEntries() {
      try { return await call("/exit-all/release", { body: { owner: true } }); }
      catch { return { released: false }; }
    },
  };
}
