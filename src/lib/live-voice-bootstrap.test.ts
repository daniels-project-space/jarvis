import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  liveVoiceRetryDelay,
  scheduleAutoLiveBootstrap,
  shouldAutoStartLiveVoice,
  speechServiceRetryDelay,
} from "./live-voice-bootstrap";

describe("live voice bootstrap policy", () => {
  it.each(["prompt", "granted"] as const)("starts the main site when microphone permission is %s", (permission) => {
    expect(shouldAutoStartLiveVoice({
      embedded: false,
      visible: true,
      liveDefault: true,
      permission,
      attempted: false,
      manuallyStopped: false,
    })).toBe(true);
  });

  it("never loops after denial, manual stop, backgrounding, or inside an embed", () => {
    const base = { embedded: false, visible: true, liveDefault: true, permission: "granted" as const, attempted: false, manuallyStopped: false };
    expect(shouldAutoStartLiveVoice({ ...base, permission: "denied" })).toBe(false);
    expect(shouldAutoStartLiveVoice({ ...base, manuallyStopped: true })).toBe(false);
    expect(shouldAutoStartLiveVoice({ ...base, visible: false })).toBe(false);
    expect(shouldAutoStartLiveVoice({ ...base, embedded: true })).toBe(false);
  });

  it("bounds startup and speech-service retry pressure", () => {
    expect([1, 2, 3, 4, 5].map(liveVoiceRetryDelay)).toEqual([1_500, 3_000, 6_000, 12_000, null]);
    expect(speechServiceRetryDelay(1)).toBe(2_000);
    expect(speechServiceRetryDelay(5)).toBe(30_000);
    expect(speechServiceRetryDelay(2, 20_000)).toBe(20_000);
    expect(speechServiceRetryDelay(2, 90_000)).toBe(30_000);
  });

  it("releases the bootstrap fence when a remembered grant arrives before the startup timer", async () => {
    vi.useFakeTimers();
    try {
      let attempted = false;
      let starts = 0;
      const setAttempted = (value: boolean) => { attempted = value; };

      const cancelPromptBootstrap = scheduleAutoLiveBootstrap(() => { starts += 1; }, setAttempted);
      expect(attempted).toBe(true);

      // A prompt -> granted permission refresh tears down the old effect before 150 ms.
      cancelPromptBootstrap();
      expect(attempted).toBe(false);
      expect(shouldAutoStartLiveVoice({
        embedded: false,
        visible: true,
        liveDefault: true,
        permission: "granted",
        attempted,
        manuallyStopped: false,
      })).toBe(true);

      const cancelGrantedBootstrap = scheduleAutoLiveBootstrap(() => { starts += 1; }, setAttempted);
      await vi.advanceTimersByTimeAsync(150);
      expect(starts).toBe(1);
      cancelGrantedBootstrap();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one browser-owned microphone request pending instead of timing out into overlapping streams", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const ensureMic = source.slice(
      source.indexOf("async function ensurePersistentLiveMic"),
      source.indexOf("function releaseLive"),
    );
    const toggleLive = source.slice(
      source.indexOf("async function toggleLive"),
      source.indexOf("async function enableMicrophone"),
    );
    expect(ensureMic).toContain("if (liveMicOpeningRef.current) return liveMicOpeningRef.current");
    expect(ensureMic.match(/getUserMedia\(/g)).toHaveLength(1);
    expect(toggleLive).not.toContain("withClientDeadline(microphone");
    expect(toggleLive).toContain("const microphoneReady = await microphone");
  });

  it("fails closed when passive narration cannot obtain the shared voice lease", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const ensureVoice = source.slice(
      source.indexOf("async function ensureVoice"),
      source.indexOf("async function narrateText"),
    );
    expect(ensureVoice).toContain("return false;");
    expect(ensureVoice).not.toContain("better one voice too many than silence");
  });
});
