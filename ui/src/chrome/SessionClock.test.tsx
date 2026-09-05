// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { SessionClock } from "./SessionClock";
import { ThemeProvider } from "./ThemeProvider";
import { soundEngine } from "../sound/SoundEngine";

const originalLocks = navigator.locks;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.removeItem("etape.sessionVoice");
  Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
});

describe("SessionClock", () => {
  it("renders the ET wall-clock time and next phase during market hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T14:30:00Z")); // 10:30:00 EDT -> RTH
    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    const text = screen.getByTestId("session-clock").textContent;
    expect(text).toContain("10:30:00");
    expect(text).toContain("POST in 05:30:00");
    vi.useRealTimers();
  });

  it("ticks forward each second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T14:30:00Z"));
    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const text = screen.getByTestId("session-clock").textContent;
    expect(text).toContain("10:30:01");
    expect(text).toContain("POST in 05:29:59");
    vi.useRealTimers();
  });

  it("counts to PRE before the trading day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T06:00:00Z")); // 02:00 EDT -> before pre-market, closed
    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    expect(screen.getByTestId("session-clock").textContent).toContain("PRE in 02:00:00");
    vi.useRealTimers();
  });

  it("uses day formatting for a weekend wait", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:00:00Z")); // Friday 21:00 EDT -> Monday PRE
    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    expect(screen.getByTestId("session-clock").textContent).toContain("PRE in 2d 07:00:00");
    vi.useRealTimers();
  });

  it("plays recordings only on PRE and RTH transitions, never on initial mount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T07:59:59Z"));
    const play = vi.spyOn(soundEngine, "sessionOpened").mockReturnValue(true);

    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    expect(play).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenNthCalledWith(1, "pre");

    vi.setSystemTime(new Date("2026-07-09T13:29:59Z"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenNthCalledWith(2, "rth");
    vi.setSystemTime(new Date("2026-07-09T19:59:59Z"));
    act(() => { vi.advanceTimersByTime(1000); });
    vi.setSystemTime(new Date("2026-07-09T23:59:59Z"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("announces one shared transition once across workspaces", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T07:59:59Z"));
    const play = vi.spyOn(soundEngine, "sessionOpened").mockReturnValue(true);
    const request = vi.fn(async (_name: string, callback: () => void) => callback());
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    localStorage.removeItem("etape.sessionVoice");

    const { unmount } = render(<ThemeProvider><><SessionClock /><SessionClock /></></ThemeProvider>);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("etape.sessionVoice")).toBe("2026-07-09:pre");

    unmount();
    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("lets another workspace play when the first is muted or audio is unavailable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T07:59:59Z"));
    const play = vi.spyOn(soundEngine, "sessionOpened").mockReturnValueOnce(false).mockReturnValue(true);
    const request = vi.fn(async (_name: string, callback: () => void) => callback());
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    render(<ThemeProvider><><SessionClock /><SessionClock /><SessionClock /></></ThemeProvider>);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("etape.sessionVoice")).toBe("2026-07-09:pre");
  });

  it("does not replay a clip when storing the shared announcement token fails", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T07:59:59Z"));
    const play = vi.spyOn(soundEngine, "sessionOpened").mockReturnValue(true);
    const request = vi.fn(async (_name: string, callback: () => void) => callback());
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    render(<ThemeProvider><SessionClock /></ThemeProvider>);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(play).toHaveBeenCalledOnce();
  });
});
