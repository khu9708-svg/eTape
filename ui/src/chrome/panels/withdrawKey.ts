// ONE stable idempotency key for the in-flight JINX withdrawal action.
//
// Persisted (localStorage) so a page reload / UNKNOWN reconcile that re-enters
// the SAME destination + amount resends the SAME key — the JINX signer then
// replays the confirmed signature or reports UNKNOWN, never a second transfer.
// A different destination or amount mints a fresh key. Cleared on success, or on
// an explicit new withdrawal started from a safe (non-UNKNOWN) phase.

const WITHDRAW_ACTIVE_SLOT = "jinx.withdraw.active";

type ActiveWithdraw = { key: string; destination: string; lamports: number };

const freshWithdrawKey = (): string =>
  `wd-${Date.now().toString(36)}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

function readActiveWithdraw(): ActiveWithdraw | null {
  try {
    return JSON.parse(window.localStorage.getItem(WITHDRAW_ACTIVE_SLOT) ?? "null") as ActiveWithdraw | null;
  } catch {
    return null;
  }
}

/** The key to use for this withdrawal attempt. Same key for the same
 *  destination+amount until it is cleared; a fresh key otherwise. */
export function mintWithdrawKey(destination: string, lamports: number): string {
  const active = readActiveWithdraw();
  if (active && active.destination === destination && active.lamports === lamports) return active.key;
  const key = freshWithdrawKey();
  try {
    window.localStorage.setItem(WITHDRAW_ACTIVE_SLOT, JSON.stringify({ key, destination, lamports }));
  } catch {
    /* private mode / disabled storage — the in-memory key is still stable for this attempt */
  }
  return key;
}

export function clearWithdrawKey(): void {
  try {
    window.localStorage.removeItem(WITHDRAW_ACTIVE_SLOT);
  } catch {
    /* ignore */
  }
}
