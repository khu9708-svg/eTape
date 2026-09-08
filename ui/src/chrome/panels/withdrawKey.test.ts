// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintWithdrawKey,
  clearWithdrawKey,
  withdrawKeyStorageOk,
  WithdrawKeyStorageError,
} from "./withdrawKey";

afterEach(() => {
  vi.restoreAllMocks();
  clearWithdrawKey();
});

describe("withdraw idempotency key", () => {
  it("returns the SAME key for the same destination+amount (retry / reload / UNKNOWN reconcile)", () => {
    const a = mintWithdrawKey("DeStAddr1111", 5_000);
    const b = mintWithdrawKey("DeStAddr1111", 5_000);
    expect(b).toBe(a);
  });

  it("persists across a simulated reload (localStorage survives the module)", () => {
    const a = mintWithdrawKey("DeStAddr1111", 5_000);
    // a fresh call with no in-memory state still reads it back from storage
    expect(mintWithdrawKey("DeStAddr1111", 5_000)).toBe(a);
  });

  it("mints a fresh key for a different amount or destination", () => {
    const a = mintWithdrawKey("DeStAddr1111", 5_000);
    expect(mintWithdrawKey("DeStAddr1111", 9_999)).not.toBe(a);
    clearWithdrawKey();
    const c = mintWithdrawKey("DeStAddr1111", 5_000);
    expect(mintWithdrawKey("OtherAddr2222", 5_000)).not.toBe(c);
  });

  it("clearing lets the next identical withdrawal get a new key", () => {
    const a = mintWithdrawKey("DeStAddr1111", 5_000);
    clearWithdrawKey();
    expect(mintWithdrawKey("DeStAddr1111", 5_000)).not.toBe(a);
  });

  it("keys match the worker's accepted format", () => {
    expect(mintWithdrawKey("DeStAddr1111", 5_000)).toMatch(/^[\w.:-]{8,128}$/);
  });

  it("THROWS (never returns an ephemeral key) when storage cannot retain it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(withdrawKeyStorageOk()).toBe(false);
    expect(() => mintWithdrawKey("DeStAddr1111", 5_000)).toThrow(WithdrawKeyStorageError);
  });

  it("THROWS when a write silently does not persist", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => null);
    expect(() => mintWithdrawKey("DeStAddr1111", 5_000)).toThrow(WithdrawKeyStorageError);
  });
});
