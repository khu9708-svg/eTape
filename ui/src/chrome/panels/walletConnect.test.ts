// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  detectWallets,
  connect,
  reconnect,
  INITIAL_WALLET_STATE,
} from "./walletConnect";

afterEach(() => {
  // clean injected providers
  delete (window as unknown as Record<string, unknown>).phantom;
  delete (window as unknown as Record<string, unknown>).backpack;
  delete (window as unknown as Record<string, unknown>).solana;
});

function fakePhantom(address: string, opts: { reject?: boolean } = {}) {
  return {
    isPhantom: true,
    connect: vi.fn(async () =>
      opts.reject ? Promise.reject(new Error("User rejected")) : { publicKey: { toString: () => address } },
    ),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe("walletConnect", () => {
  it("detects nothing when no wallet is injected", () => {
    expect(detectWallets()).toEqual([]);
  });

  it("detects an injected Phantom provider", () => {
    (window as unknown as Record<string, unknown>).phantom = { solana: fakePhantom("OWNER1") };
    const found = detectWallets();
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("phantom");
  });

  it("connect returns owner_verified when the address matches the expected owner", async () => {
    (window as unknown as Record<string, unknown>).phantom = { solana: fakePhantom("OWNER1") };
    const s = await connect("phantom", "OWNER1");
    expect(s.phase).toBe("owner_verified");
    expect(s.address).toBe("OWNER1");
  });

  it("connect returns owner_mismatch when the address differs", async () => {
    (window as unknown as Record<string, unknown>).phantom = { solana: fakePhantom("SOMEONE_ELSE") };
    const s = await connect("phantom", "OWNER1");
    expect(s.phase).toBe("owner_mismatch");
  });

  it("a rejected connect surfaces the error and stays disconnected", async () => {
    (window as unknown as Record<string, unknown>).phantom = { solana: fakePhantom("X", { reject: true }) };
    const s = await connect("phantom", "OWNER1");
    expect(s.phase).toBe("disconnected");
    expect(s.error).toMatch(/rejected/i);
  });

  it("reconnect on a missing wallet returns the initial disconnected state", async () => {
    const s = await reconnect("phantom", "OWNER1");
    expect(s.phase).toBe(INITIAL_WALLET_STATE.phase);
  });

  it("connect with no expected owner is 'connected', not verified", async () => {
    (window as unknown as Record<string, unknown>).phantom = { solana: fakePhantom("ANY") };
    const s = await connect("phantom", null);
    expect(s.phase).toBe("connected");
  });
});
