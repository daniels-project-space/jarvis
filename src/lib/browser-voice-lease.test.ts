import { describe, expect, it } from "vitest";
import { startLiveWithLease } from "./live-voice-bootstrap";
import {
  tryAcquireBrowserVoiceLease,
  type BrowserVoiceLease,
  type BrowserVoiceLockManager,
} from "./browser-voice-lease";

function exclusiveLockManager(): BrowserVoiceLockManager {
  let held = false;
  return {
    async request(_name, options, callback) {
      expect(options).toEqual({ mode: "exclusive", ifAvailable: true });
      if (held) {
        await callback(null);
        return;
      }
      held = true;
      try {
        await callback({});
      } finally {
        held = false;
      }
    },
  };
}

describe("browser live microphone lease", () => {
  it("gives one same-origin contender the microphone and hands it off after release", async () => {
    const locks = exclusiveLockManager();
    const first = await tryAcquireBrowserVoiceLease({ locks });
    const second = await tryAcquireBrowserVoiceLease({ locks });

    expect(first.status).toBe("acquired");
    expect(second).toEqual({ status: "busy" });
    if (first.status !== "acquired") throw new Error("first contender should own the browser lock");

    await Promise.all([first.lease.release(), first.lease.release()]);
    await expect(first.lease.released).resolves.toBeUndefined();

    const third = await tryAcquireBrowserVoiceLease({ locks });
    expect(third.status).toBe("acquired");
    if (third.status === "acquired") await third.lease.release();
  });

  it("releases the browser lock when microphone startup fails", async () => {
    const locks = exclusiveLockManager();
    let heldLease: BrowserVoiceLease | null = null;
    const failure = new DOMException("blocked", "NotAllowedError");

    await expect(startLiveWithLease({
      acquireLiveLease: async () => {
        const outcome = await tryAcquireBrowserVoiceLease({ locks });
        if (outcome.status !== "acquired") return false;
        heldLease = outcome.lease;
        return true;
      },
      openMicrophone: async () => { throw failure; },
      releaseLiveLease: async () => {
        await heldLease?.release();
        heldLease = null;
      },
    })).resolves.toEqual({ status: "failed", stage: "microphone", error: failure });

    const next = await tryAcquireBrowserVoiceLease({ locks });
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") await next.lease.release();
  });

  it("releases the browser lock after a late microphone result is cancelled", async () => {
    const locks = exclusiveLockManager();
    let heldLease: BrowserVoiceLease | null = null;
    let resolveMicrophone!: (value: { id: string }) => void;
    const microphone = new Promise<{ id: string }>((resolve) => { resolveMicrophone = resolve; });
    let wanted = true;

    const start = startLiveWithLease({
      acquireLiveLease: async () => {
        const outcome = await tryAcquireBrowserVoiceLease({ locks });
        if (outcome.status !== "acquired") return false;
        heldLease = outcome.lease;
        return true;
      },
      openMicrophone: () => microphone,
      releaseLiveLease: async () => {
        await heldLease?.release();
        heldLease = null;
      },
      isStillWanted: () => wanted,
    });

    await Promise.resolve();
    wanted = false;
    resolveMicrophone({ id: "late" });
    await expect(start).resolves.toEqual({ status: "cancelled" });

    const next = await tryAcquireBrowserVoiceLease({ locks });
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") await next.lease.release();
  });

  it("fails closed when Browser Locks are unavailable or the request fails", async () => {
    expect(await tryAcquireBrowserVoiceLease({ locks: null })).toEqual({ status: "unsupported" });
    const error = new Error("locks blocked");
    const failed = await tryAcquireBrowserVoiceLease({
      locks: { request: async () => { throw error; } },
    });
    expect(failed).toEqual({ status: "failed", error });
  });
});
