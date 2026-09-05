// Phantom / Backpack wallet connection for the KAYJAY Face.
//
// Adapted from the proven browser-injection + Wallet-Standard patterns in the
// donor kits (Unified-Wallet-Kit's adapter model, Backpack's provider surface):
// detect -> connect -> reconnect -> reactive state, with a hard OWNER wallet vs
// EXECUTION signer distinction. This never signs for JINX autonomous execution
// (that stays on the D5f local signer server-side); Phantom is the OWNER wallet
// identity + owner-approved signing surface only.

export type WalletKind = "phantom" | "backpack";

export interface DetectedWallet {
  kind: WalletKind;
  name: string;
  icon: string;
  provider: SolanaProvider;
}

interface SolanaProvider {
  isPhantom?: boolean;
  isBackpack?: boolean;
  publicKey?: { toString(): string } | null;
  isConnected?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  on(event: string, handler: (arg?: unknown) => void): void;
  removeListener?(event: string, handler: (arg?: unknown) => void): void;
  signMessage?(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

type WindowWithWallets = Window & {
  phantom?: { solana?: SolanaProvider };
  backpack?: SolanaProvider;
  solana?: SolanaProvider;
};

const PHANTOM_ICON =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHZpZXdCb3g9IjAgMCAzNCAzNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHJ4PSI4IiBmaWxsPSIjQUI5RkYyIi8+PC9zdmc+";
const BACKPACK_ICON =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHZpZXdCb3g9IjAgMCAzNCAzNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzQiIGhlaWdodD0iMzQiIHJ4PSI4IiBmaWxsPSIjRTMzRTNGIi8+PC9zdmc+";

export function detectWallets(): DetectedWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as WindowWithWallets;
  const out: DetectedWallet[] = [];
  const phantom = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  if (phantom) out.push({ kind: "phantom", name: "Phantom", icon: PHANTOM_ICON, provider: phantom });
  const backpack = w.backpack ?? (w.solana?.isBackpack ? w.solana : undefined);
  if (backpack) out.push({ kind: "backpack", name: "Backpack", icon: BACKPACK_ICON, provider: backpack });
  return out;
}

export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "owner_verified"
  | "owner_mismatch";

export interface WalletConnectionState {
  phase: ConnectionPhase;
  kind: WalletKind | null;
  address: string | null;
  expectedOwner: string | null;
  error: string | null;
  lastResponseAt: string | null;
}

export const INITIAL_WALLET_STATE: WalletConnectionState = {
  phase: "disconnected",
  kind: null,
  address: null,
  expectedOwner: null,
  error: null,
  lastResponseAt: null,
};

function classify(address: string, expectedOwner: string | null): ConnectionPhase {
  if (!expectedOwner) return "connected";
  return address === expectedOwner ? "owner_verified" : "owner_mismatch";
}

/** Silent reconnect — only if the wallet already trusts this origin. */
export async function reconnect(
  kind: WalletKind,
  expectedOwner: string | null,
): Promise<WalletConnectionState> {
  const detected = detectWallets().find((d) => d.kind === kind);
  if (!detected) return { ...INITIAL_WALLET_STATE, error: `${kind} is not installed` };
  try {
    const res = await detected.provider.connect({ onlyIfTrusted: true });
    const address = res.publicKey.toString();
    return {
      phase: classify(address, expectedOwner),
      kind,
      address,
      expectedOwner,
      error: null,
      lastResponseAt: new Date().toISOString(),
    };
  } catch {
    return { ...INITIAL_WALLET_STATE, expectedOwner };
  }
}

/** Interactive connect — this is the step that shows the Phantom approval popup. */
export async function connect(
  kind: WalletKind,
  expectedOwner: string | null,
): Promise<WalletConnectionState> {
  const detected = detectWallets().find((d) => d.kind === kind);
  if (!detected) {
    return { ...INITIAL_WALLET_STATE, kind, expectedOwner, error: `${kind} is not installed` };
  }
  try {
    const res = await detected.provider.connect();
    const address = res.publicKey.toString();
    return {
      phase: classify(address, expectedOwner),
      kind,
      address,
      expectedOwner,
      error: null,
      lastResponseAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ...INITIAL_WALLET_STATE,
      kind,
      expectedOwner,
      error: e instanceof Error ? e.message : "connection rejected",
    };
  }
}

export async function disconnect(kind: WalletKind): Promise<void> {
  const detected = detectWallets().find((d) => d.kind === kind);
  try { await detected?.provider.disconnect(); } catch { /* already gone */ }
}

/** Subscribe to accountChanged / disconnect so the Face stays honest. */
export function subscribe(
  kind: WalletKind,
  expectedOwner: string | null,
  onChange: (s: WalletConnectionState) => void,
): () => void {
  const detected = detectWallets().find((d) => d.kind === kind);
  if (!detected) return () => {};
  const onAccount = (arg?: unknown) => {
    const pk = arg as { toString(): string } | null | undefined;
    if (!pk) { onChange({ ...INITIAL_WALLET_STATE, kind, expectedOwner }); return; }
    const address = pk.toString();
    onChange({
      phase: classify(address, expectedOwner),
      kind, address, expectedOwner, error: null,
      lastResponseAt: new Date().toISOString(),
    });
  };
  const onDisc = () => onChange({ ...INITIAL_WALLET_STATE, kind, expectedOwner });
  detected.provider.on("accountChanged", onAccount);
  detected.provider.on("disconnect", onDisc);
  return () => {
    detected.provider.removeListener?.("accountChanged", onAccount);
    detected.provider.removeListener?.("disconnect", onDisc);
  };
}
