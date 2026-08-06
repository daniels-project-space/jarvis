import { describe, expect, it, vi } from "vitest";
import { ClientDeadlineError, withClientDeadline } from "./client-deadline";

describe("withClientDeadline", () => {
  it("returns an operation that finishes inside the bound", async () => {
    await expect(withClientDeadline(Promise.resolve("ready"), 100, "ownership")).resolves.toBe("ready");
  });

  it("rejects a hung operation and ignores its late result", async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const operation = new Promise<string>((resolve) => { finish = resolve; });
    const bounded = withClientDeadline(operation, 5_000, "ownership");
    const assertion = expect(bounded).rejects.toBeInstanceOf(ClientDeadlineError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    finish("late");
    await Promise.resolve();
    vi.useRealTimers();
  });
});
