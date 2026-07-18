import { describe, expect, it, vi } from "vitest";
import { runConcurrentClaimLoop } from "./agent-pool";

describe("subscription agent claim pool", () => {
  it("claims a follow-up while an earlier job is still running", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: string[] = [];
    let claims = 0;
    const claim = vi.fn(async () => {
      claims += 1;
      if (claims === 1) return "first";
      if (claims === 3) return "follow-up";
      return null;
    });
    const running = runConcurrentClaimLoop({
      capacity: 3,
      claimWindowMs: 2_000,
      idleDrainMs: 10,
      pollIntervalMs: 1,
      claim,
      run: async (job) => {
        started.push(job);
        if (job === "first") await firstDone;
      },
    });

    await vi.waitFor(() => expect(started).toEqual(["first", "follow-up"]));
    releaseFirst();
    await expect(running).resolves.toBe(2);
  });

  it("never exceeds the configured per-wake process cap", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let next = 0;
    let active = 0;
    let peak = 0;
    const running = runConcurrentClaimLoop({
      capacity: 3,
      claimWindowMs: 2_000,
      idleDrainMs: 5,
      pollIntervalMs: 1,
      claim: async () => (next < 4 ? ++next : null),
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
      },
    });

    await vi.waitFor(() => expect(peak).toBe(3));
    release();
    await running;
    expect(peak).toBe(3);
  });
});
