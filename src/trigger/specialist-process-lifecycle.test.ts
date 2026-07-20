import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpecialistExitBarrier } from "./specialist-process-lifecycle";

class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

afterEach(() => vi.useRealTimers());

describe("specialist-to-controller credential handoff", () => {
  it("does not release after SIGKILL until the namespace process is actually closed", async () => {
    const child = new FakeChild();
    const barrier = createSpecialistExitBarrier(child);
    let released = false;
    void barrier.exited.then(() => { released = true; });

    barrier.requestStop({ timedOut: true, stopped: null });
    await Promise.resolve();
    expect(child.signals).toEqual(["SIGKILL"]);
    expect(released).toBe(false);

    child.emit("close", null, "SIGKILL");
    await expect(barrier.exited).resolves.toMatchObject({
      timedOut: true,
      stopped: null,
      code: null,
      signal: "SIGKILL",
    });
    expect(released).toBe(true);
  });

  it("waits for close after a process error and preserves the first stop owner", async () => {
    const child = new FakeChild();
    const barrier = createSpecialistExitBarrier(child);
    const observed = vi.fn();
    void barrier.exited.then(observed);

    barrier.requestStop({ timedOut: false, stopped: "cancelled" });
    barrier.requestStop({ timedOut: true, stopped: null });
    child.emit("error", new Error("synthetic process error"));
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    expect(child.signals).toEqual(["SIGKILL"]);

    child.emit("close", 1, null);
    await expect(barrier.exited).resolves.toMatchObject({
      timedOut: false,
      stopped: "cancelled",
      code: 1,
      error: expect.objectContaining({ message: "synthetic process error" }),
    });
  });

  it("escalates a graceful pause to SIGKILL without weakening the close barrier", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const barrier = createSpecialistExitBarrier(child);
    const observed = vi.fn();
    void barrier.exited.then(observed);

    barrier.requestStop({ timedOut: false, stopped: "paused" }, 3_000);
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(observed).not.toHaveBeenCalled();

    child.emit("close", null, "SIGKILL");
    await expect(barrier.exited).resolves.toMatchObject({ stopped: "paused" });
  });
});
