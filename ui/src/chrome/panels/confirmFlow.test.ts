import { describe, expect, it } from "vitest";
import { stepsForPhase, isConfirmed } from "./confirmFlow";

const L: [string, string, string, string] = ["Review", "Confirm", "Submit", "Reconcile"];

describe("confirmFlow", () => {
  it("enter shows the review step active and the rest upcoming", () => {
    const s = stepsForPhase("enter", L);
    expect(s.map((x) => x.state)).toEqual(["active", "upcoming", "upcoming", "upcoming"]);
  });

  it("review_ready advances: review done, confirm active", () => {
    const s = stepsForPhase("review_ready", L);
    expect(s[0].state).toBe("done");
    expect(s[1].state).toBe("active");
  });

  it("confirming marks confirm running", () => {
    expect(stepsForPhase("confirming", L)[1].state).toBe("running");
  });

  it("submitted marks submit done and reconcile active", () => {
    const s = stepsForPhase("submitted", L);
    expect(s[2].state).toBe("done");
    expect(s[3].state).toBe("active");
  });

  it("success marks every step done", () => {
    expect(stepsForPhase("success", L).every((x) => x.state === "done")).toBe(true);
  });

  it("failed / unknown mark the in-flight step failed, earlier steps done", () => {
    for (const p of ["failed", "unknown"] as const) {
      const s = stepsForPhase(p, L);
      expect(s[0].state).toBe("done");
      expect(s[1].state).toBe("failed");
      expect(s[2].state).toBe("failed");
    }
  });

  it("isConfirmed requires the exact typed phrase for destructive actions", () => {
    expect(isConfirmed({ requireTyped: "EXIT ALL", typedValue: "exit all" })).toBe(false);
    expect(isConfirmed({ requireTyped: "EXIT ALL", typedValue: " EXIT ALL " })).toBe(true);
    expect(isConfirmed({ checked: true })).toBe(true);
    expect(isConfirmed({ checked: false })).toBe(false);
  });
});
