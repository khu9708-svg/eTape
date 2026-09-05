import { describe, it, expect, vi, afterEach } from "vitest";
import { WebAudioPatchPlayer, FILL_PATCHES, REJECT_PATCHES, SCANNER_PATCHES, resolvePatch } from "./patches";
import { FILL_SOUND_IDS, REJECT_SOUND_IDS, SCANNER_SOUND_IDS } from "./SoundConfig";

afterEach(() => { vi.unstubAllGlobals(); });

describe("WebAudioPatchPlayer (node env, no Web Audio)", () => {
  it("unlock / setMasterVolume / play are safe no-ops when AudioContext is undefined", () => {
    const p = new WebAudioPatchPlayer();
    expect(() => p.unlock()).not.toThrow();
    expect(() => p.setMasterVolume(0.5)).not.toThrow();
    expect(() =>
      p.play(() => {
        throw new Error("must not run");
      }, "buy")
    ).not.toThrow();
  });
});

describe("recorded audio", () => {
  function audio() {
    const buffer = {} as AudioBuffer;
    const master = { gain: { value: 1 }, connect: vi.fn() };
    const source = { buffer: null, connect: vi.fn(), start: vi.fn() };
    const ctx = {
      state: "suspended",
      destination: {},
      createGain: () => master,
      resume: vi.fn(async () => { ctx.state = "running"; }),
      decodeAudioData: vi.fn(async () => buffer),
      createBufferSource: vi.fn(() => source),
    };
    vi.stubGlobal("AudioContext", class { constructor() { return ctx; } });
    const fetchAudio = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
    vi.stubGlobal("fetch", fetchAudio);
    return { player: new WebAudioPatchPlayer(), ctx, master, source, buffer, fetchAudio };
  }

  it("preloads once and plays through master gain only when unlocked and ready", async () => {
    const { player, ctx, master, source, buffer, fetchAudio } = audio();
    expect(player.playRecording("/clip.mp3")).toBe(false);
    await player.preloadRecording("/clip.mp3");
    expect(fetchAudio).not.toHaveBeenCalled();
    player.setMasterVolume(0.4);
    player.unlock();
    const loading = player.preloadRecording("/clip.mp3");
    expect(player.playRecording("/clip.mp3")).toBe(false);
    await loading;
    await player.preloadRecording("/clip.mp3");
    expect(fetchAudio).toHaveBeenCalledTimes(1);
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(source.start).not.toHaveBeenCalled(); // a dropped transition never replays after loading
    ctx.state = "suspended";
    expect(player.playRecording("/clip.mp3")).toBe(false);
    ctx.state = "running";
    expect(player.playRecording("/clip.mp3")).toBe(true);
    expect(source.buffer).toBe(buffer);
    expect(source.connect).toHaveBeenCalledWith(master);
    expect(master.gain.value).toBeCloseTo(0.16);
    expect(source.start).toHaveBeenCalledOnce();
  });

  it("drops failed loads or playback without throwing, and permits a later load retry", async () => {
    const { player, fetchAudio, source } = audio();
    player.unlock();
    fetchAudio.mockResolvedValueOnce({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(player.preloadRecording("/clip.mp3")).resolves.toBeUndefined();
    expect(player.playRecording("/clip.mp3")).toBe(false);
    await player.preloadRecording("/clip.mp3");
    expect(fetchAudio).toHaveBeenCalledTimes(2);
    source.start.mockImplementationOnce(() => { throw new Error("audio unavailable"); });
    expect(player.playRecording("/clip.mp3")).toBe(false);
    expect(player.playRecording("/clip.mp3")).toBe(true);
  });
});

describe("patch registries", () => {
  it("has a patch for every configured sound id", () => {
    for (const id of FILL_SOUND_IDS) expect(typeof FILL_PATCHES[id]).toBe("function");
    for (const id of REJECT_SOUND_IDS) expect(typeof REJECT_PATCHES[id]).toBe("function");
    for (const id of SCANNER_SOUND_IDS) expect(typeof SCANNER_PATCHES[id]).toBe("function");
    expect(typeof resolvePatch("place", "x")).toBe("function");
    expect(resolvePatch("fill", "bogus")).toBeUndefined();
  });
});
