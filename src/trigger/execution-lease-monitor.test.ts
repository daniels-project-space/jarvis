import { describe, expect, it } from "vitest";
import { ExecutionLeaseMonitor } from "./execution-lease-monitor";

describe("execution lease monitor", () => {
  it("keeps a bounded subscription lease, queries once after disconnect, and accepts reconnect", async () => {
    let now = 1_000; let calls = 0;
    const monitor = new ExecutionLeaseMonitor(2, 4, async () => { calls += 1; return { status: "running", attempt: 2, steerRevision: 4 }; }, () => now);
    monitor.observe({ status: "running", attempt: 2, steerRevision: 4 });
    expect(await monitor.status()).toBe("running");
    expect(calls).toBe(0);
    now += 30_001;
    expect(await monitor.status()).toBe("running");
    expect(calls).toBe(1);
    now += 1;
    expect(await monitor.status()).toBe("running");
    expect(calls).toBe(1);
    monitor.observe({ status: "running", attempt: 2, steerRevision: 5 });
    expect(await monitor.status()).toBe("steered");
  });

  it("returns unknown after a bounded failed fallback rather than abandoning work", async () => {
    let now = 50_000; let calls = 0;
    const monitor = new ExecutionLeaseMonitor(1, 0, async () => { calls += 1; throw new Error("socket/query outage"); }, () => now);
    expect(await monitor.status()).toBe("unknown");
    expect(await monitor.status()).toBe("unknown");
    expect(calls).toBe(1);
    now += 15_000;
    expect(await monitor.status()).toBe("unknown");
    expect(calls).toBe(2);
  });
});
