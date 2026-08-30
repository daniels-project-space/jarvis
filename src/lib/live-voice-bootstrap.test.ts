import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  coalesceLiveVoiceStart,
  liveVoiceRetryDelay,
  loadLiveVoiceStartupDependency,
  scheduleAutoLiveBootstrap,
  shouldAutoStartLiveVoice,
  speechServiceRetryDelay,
  startLiveWithLease,
} from "./live-voice-bootstrap";
import { SPOKEN_CAPTION_TEXT_CLASS, spokenCaptionStageClassName } from "./spoken-caption-layout";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("live voice bootstrap policy", () => {
  it("defaults to local wake-only instead of continuous capture", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    expect(source).toContain('liveDefault: localStorage.getItem("jarvis_live_default") === "1"');
    expect(source).toContain('const wakeIsEnabled = () => localStorage.getItem(wakePreferenceKey) !== "0"');
    expect(source).toContain('localStorage.setItem(wakePreferenceKey, "1")');
    expect(source).toContain('setPref("liveDefault", false)');
    expect(shouldAutoStartLiveVoice({ embedded: false, visible: true, liveDefault: false, permission: "granted", attempted: false, manuallyStopped: false })).toBe(false);
  });

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

  it("cleans up a current pending start when its lazy voice module fails, without touching a replacement", async () => {
    const failure = new Error("offline module");
    const onCurrentFailure = vi.fn();
    const current = await loadLiveVoiceStartupDependency({
      load: async () => { throw failure; },
      isStillCurrent: () => true,
      onFailure: onCurrentFailure,
    });
    expect(current).toBeNull();
    expect(onCurrentFailure).toHaveBeenCalledTimes(1);

    const onStaleFailure = vi.fn();
    const stale = await loadLiveVoiceStartupDependency({
      load: async () => { throw failure; },
      isStillCurrent: () => false,
      onFailure: onStaleFailure,
    });
    expect(stale).toBeNull();
    expect(onStaleFailure).not.toHaveBeenCalled();
  });

  it("coalesces concurrent force-start waiters onto one lease and microphone startup", async () => {
    const pending = deferred<boolean>();
    const begin = vi.fn(() => pending.promise);

    const first = coalesceLiveVoiceStart(null, begin);
    const second = coalesceLiveVoiceStart(first, begin);

    expect(second).toBe(first);
    expect(begin).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await expect(second).resolves.toBe(true);
  });

  it("does not reuse a cancelled start when visibility resumes before it settles", async () => {
    const firstPending = deferred<boolean>();
    const firstBegin = vi.fn(() => firstPending.promise);
    const first = coalesceLiveVoiceStart(null, firstBegin);
    let current: Promise<boolean> | null = first;

    // `endFreeVoiceSession` invalidates the coalescing slot before a hidden
    // tab can become visible and request a replacement start.
    current = null;
    const secondPending = deferred<boolean>();
    const secondBegin = vi.fn(() => secondPending.promise);
    const resumed = coalesceLiveVoiceStart(current, secondBegin);

    expect(resumed).not.toBe(first);
    expect(firstBegin).toHaveBeenCalledTimes(1);
    expect(secondBegin).toHaveBeenCalledTimes(1);
    secondPending.resolve(true);
    await expect(resumed).resolves.toBe(true);
    firstPending.resolve(false);
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
      source.indexOf("async function runToggleLive"),
      source.indexOf("async function enableMicrophone"),
    );
    expect(ensureMic).toContain("if (liveMicOpeningRef.current) return liveMicOpeningRef.current");
    expect(ensureMic.match(/getUserMedia\(/g)).toHaveLength(1);
    expect(toggleLive).not.toContain("withClientDeadline(microphone");
    expect(toggleLive).toContain("startLiveWithLease({");
    expect(toggleLive).toContain("openMicrophone: ensurePersistentLiveMic");
    expect(toggleLive).not.toContain("const microphone = ensurePersistentLiveMic");
    expect(toggleLive).toContain("shouldCloseCancelledMicrophone:");
    expect(toggleLive).toContain("|| (!liveRef.current && !liveStartPendingRef.current)");
  });

  it("takes an origin-wide browser lease before a guest or overlay can open capture", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const toggleLive = source.slice(
      source.indexOf("async function runToggleLive"),
      source.indexOf("async function enableMicrophone"),
    );
    expect(toggleLive).toContain("await tryAcquireBrowserVoiceLease({");
    expect(toggleLive).toContain("if (guest) return true;");
    expect(toggleLive).not.toContain("guest\n      ? Promise.resolve(true)");
    expect(toggleLive).toContain("releaseLiveLease: releaseStartLease");
  });

  it("stops standby recognition before a disconnected server lease can hand off", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    expect(source).toContain("createStandbyListenerLeaseFence");
    expect(source).toContain("renewStandbyListenerLease");
    expect(source).toContain("onRenewed: () => {");
    expect(source).toContain("onLost: releaseStandbyListener");
    expect(source).toContain("standbyLeaseFence.clear()");
  });

  it("does not re-arm standby recognition while persistent live capture is active or opening", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const rearmWake = source.slice(
      source.indexOf("rearmWake = () =>"),
      source.indexOf("function toggleWake"),
    );

    expect(rearmWake).toContain("shouldArmStandbyListener({");
    expect(rearmWake).toContain("live: liveCaptureIsActiveOrStarting()");
    // Both asynchronous handoffs re-check this policy: a live session can
    // start while the remote lease or the wakeword module is still loading.
    expect(rearmWake.match(/live: liveCaptureIsActiveOrStarting\(\)/g)).toHaveLength(3);
    expect(rearmWake).toContain("if (!listening && standbyLeaseOwnedRef.current && isCurrentStandbyLease(lease))");
    expect(rearmWake).toContain("if (standbyLeaseOwnedRef.current && isCurrentStandbyLease(lease)) {");
    expect(source).toContain("const liveStartPendingRef = useRef(false);");
  });

  it("cancels an opening live start and clears a failed lazy-module fence", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const toggleLive = source.slice(
      source.indexOf("async function runToggleLive"),
      source.indexOf("async function enableMicrophone"),
    );

    expect(toggleLive).toContain("liveStartPendingRef.current = true;");
    expect(toggleLive).toContain("liveStartPendingRef.current = false;");
    expect(toggleLive).toContain("liveRef.current || live !== \"off\" || liveStartPendingRef.current");
    expect(toggleLive).toContain("loadLiveVoiceStartupDependency({");
    expect(toggleLive).toContain("onFailure: () => {");
    expect(toggleLive).toContain("rearmWake();");
    const toggleLiveWrapper = source.slice(
      source.indexOf("function toggleLive"),
      source.indexOf("async function runToggleLive"),
    );
    expect(toggleLiveWrapper).toContain("const existingStart = liveStartPromiseRef.current;");
    expect(toggleLiveWrapper).toContain("if (existingStart) return existingStart;");
    expect(toggleLiveWrapper).toContain("coalesceLiveVoiceStart(");
    const endFreeVoiceSession = source.slice(
      source.indexOf("function endFreeVoiceSession"),
      source.indexOf("function toggleLive"),
    );
    expect(endFreeVoiceSession).toContain("liveStartPromiseRef.current = null;");
    expect(source).toContain("if (message.jarvis === \"host-hide\" && liveCaptureIsActiveOrStarting()) void toggleLive();");
    expect(source).toContain("if (!liveCaptureIsActiveOrStarting()) return;");
  });

  it("keeps the single spoken transcript slightly smaller and lower than the orb", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    expect(source).toContain("SPOKEN_CAPTION_TEXT_CLASS");
    expect(source).toContain("spokenCaptionStageClassName({ compactAside, commandExpanded, overlayUp })");
    expect(SPOKEN_CAPTION_TEXT_CLASS).toBe(
      "text-[0.95rem] font-semibold leading-snug tracking-tight md:text-[1.3rem] lg:text-[1.5rem]",
    );
    expect(spokenCaptionStageClassName({ compactAside: false, commandExpanded: false, overlayUp: false }))
      .toBe("top-[63%] inset-x-0");
  });

  it("opens capture only after its shared live lease wins across documents", async () => {
    const firstLease = deferred<boolean>();
    const secondLease = deferred<boolean>();
    const firstMicrophone = { id: "main" };
    const secondMicrophone = { id: "embed" };
    const openFirst = vi.fn(async () => firstMicrophone);
    const openSecond = vi.fn(async () => secondMicrophone);

    const first = startLiveWithLease({
      acquireLiveLease: () => firstLease.promise,
      openMicrophone: openFirst,
      releaseLiveLease: vi.fn(),
    });
    const second = startLiveWithLease({
      acquireLiveLease: () => secondLease.promise,
      openMicrophone: openSecond,
      releaseLiveLease: vi.fn(),
    });

    await Promise.resolve();
    expect(openFirst).not.toHaveBeenCalled();
    expect(openSecond).not.toHaveBeenCalled();

    firstLease.resolve(true);
    secondLease.resolve(false);

    await expect(first).resolves.toEqual({ status: "ready", microphone: firstMicrophone });
    await expect(second).resolves.toEqual({ status: "not-owned" });
    expect(openFirst).toHaveBeenCalledTimes(1);
    expect(openSecond).not.toHaveBeenCalled();
  });

  it("releases its live lease when the winning microphone cannot open", async () => {
    const releaseLiveLease = vi.fn(async () => {});
    const error = new DOMException("blocked", "NotAllowedError");

    await expect(startLiveWithLease({
      acquireLiveLease: async () => true,
      openMicrophone: async () => { throw error; },
      releaseLiveLease,
    })).resolves.toEqual({ status: "failed", stage: "microphone", error });
    expect(releaseLiveLease).toHaveBeenCalledTimes(1);
  });

  it("closes a late microphone and releases the lease after cancellation", async () => {
    const microphone = deferred<{ id: string }>();
    const closeMicrophone = vi.fn();
    const releaseLiveLease = vi.fn(async () => {});
    let wanted = true;

    const start = startLiveWithLease({
      acquireLiveLease: async () => true,
      openMicrophone: () => microphone.promise,
      releaseLiveLease,
      isStillWanted: () => wanted,
      closeMicrophone,
    });
    await Promise.resolve();
    wanted = false;
    microphone.resolve({ id: "late" });

    await expect(start).resolves.toEqual({ status: "cancelled" });
    expect(closeMicrophone).toHaveBeenCalledWith({ id: "late" });
    expect(releaseLiveLease).toHaveBeenCalledTimes(1);
  });

  it("leaves a shared late microphone open when a newer start adopted it", async () => {
    const microphone = deferred<{ id: string }>();
    const closeFirstMicrophone = vi.fn();
    const releaseFirstLease = vi.fn(async () => {});
    const releaseSecondLease = vi.fn(async () => {});
    let firstWanted = true;
    let secondWanted = false;

    const first = startLiveWithLease({
      acquireLiveLease: async () => true,
      openMicrophone: () => microphone.promise,
      releaseLiveLease: releaseFirstLease,
      isStillWanted: () => firstWanted,
      shouldCloseCancelledMicrophone: () => !secondWanted,
      closeMicrophone: closeFirstMicrophone,
    });
    await Promise.resolve();

    firstWanted = false;
    secondWanted = true;
    const second = startLiveWithLease({
      acquireLiveLease: async () => true,
      openMicrophone: () => microphone.promise,
      releaseLiveLease: releaseSecondLease,
      isStillWanted: () => secondWanted,
    });
    microphone.resolve({ id: "shared" });

    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toEqual({ status: "ready", microphone: { id: "shared" } });
    expect(closeFirstMicrophone).not.toHaveBeenCalled();
    expect(releaseFirstLease).toHaveBeenCalledTimes(1);
    expect(releaseSecondLease).not.toHaveBeenCalled();
  });

  it("releases the current tokenized live lease when the UI unmounts without pagehide", () => {
    const source = readFileSync(new URL("../components/JarvisUI.tsx", import.meta.url), "utf8");
    const releaseLive = source.slice(
      source.indexOf("function releaseLive()"),
      source.indexOf("function endFreeVoiceSession"),
    );
    const unmountStart = source.indexOf("useEffect(() => () => {", source.indexOf("async function runToggleLive"));
    const unmount = source.slice(unmountStart, source.indexOf("  }, []);", unmountStart));

    expect(source).toContain("const releaseLiveOnUnmountRef = useRef<() => void>(() => {});");
    expect(source).toContain("releaseLiveOnUnmountRef.current = releaseLive;");
    expect(unmount).toContain("freeLoop.current = false;");
    expect(unmount).toContain("releaseLiveOnUnmountRef.current();");
    expect(releaseLive).toContain("if (liveBeat.current) clearInterval(liveBeat.current);");
    expect(releaseLive).toContain("liveRemoteLeaseRef.current = null;");
    expect(releaseLive).toContain("liveLeaseId: remoteLease.id");
    expect(releaseLive).toContain("liveLeaseSequence: remoteLease.sequence");
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
