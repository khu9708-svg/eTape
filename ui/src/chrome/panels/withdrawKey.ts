// ONE stable idempotency key for the in-flight JINX withdrawal action.
//
// It MUST be durable. If localStorage cannot store it, the withdrawal is blocked
// entirely — for a fund-moving action, an ephemeral key that a reload or a
// second submit would not recover is worse than not submitting at all. There is
// no `Math.random` fallback.
//
// When it is durable: a page reload / UNKNOWN reconcile that re-enters the SAME
// destination + amount reuses the SAME key — the JINX signer then replays the
// confirmed signature or reports UNKNOWN, never a second transfer. A different
// destination or amount mints a fresh key. Cleared only on authoritative
// success, or on an explicit new withdrawal from a safe (non-UNKNOWN) phase.

const WITHDRAW_ACTIVE_SLOT = "jinx.withdraw.active";

type ActiveWithdraw = { key: string; destination: string; lamports: number };

export class WithdrawKeyStorageError extends Error {
  constructor() {
    super("IDEMPOTENCY STORAGE UNAVAILABLE — WITHDRAWAL BLOCKED");
    this.name = "WithdrawKeyStorageError";
  }
}

/** True only if we can actually persist and read back a value. */
export function withdrawKeyStorageOk(): boolean {
  try {
    const probe = `${WITHDRAW_ACTIVE_SLOT}.probe`;
    window.localStorage.setItem(probe, "1");
    const ok = window.localStorage.getItem(probe) === "1";
    window.localStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

const freshWithdrawKey = (): string =>
  `wd-${Date.now().toString(36)}-${
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.trunc(performance.now() * 1e6)}`
  }`;

function readActiveWithdraw(): ActiveWithdraw | null {
  try {
    return JSON.parse(
      window.localStorage.getItem(WITHDRAW_ACTIVE_SLOT) ?? "null",
    ) as ActiveWithdraw | null;
  } catch {
    return null;
  }
}

/** The key to use for this withdrawal attempt. Same key for the same
 *  destination+amount until it is cleared. THROWS `WithdrawKeyStorageError` if
 *  the key cannot be durably retained — the caller must NOT submit. */
export function mintWithdrawKey(destination: string, lamports: number): string {
  const active = readActiveWithdraw();
  if (active && active.destination === destination && active.lamports === lamports) return active.key;
  const key = freshWithdrawKey();
  try {
    window.localStorage.setItem(WITHDRAW_ACTIVE_SLOT, JSON.stringify({ key, destination, lamports }));
  } catch {
    throw new WithdrawKeyStorageError();
  }
  if (window.localStorage.getItem(WITHDRAW_ACTIVE_SLOT) === null) throw new WithdrawKeyStorageError();
  return key;
}

export function clearWithdrawKey(): void {
  try {
    window.localStorage.removeItem(WITHDRAW_ACTIVE_SLOT);
  } catch {
    /* ignore */
  }
}
