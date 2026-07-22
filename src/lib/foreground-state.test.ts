import { describe, expect, it } from "vitest";
import { isForegroundBusy } from "./foreground-state";

describe("isForegroundBusy", () => {
  it("ignores held or stale transcript history when the newest turn is done", () => {
    expect(isForegroundBusy([
      { role: "user", status: "pending", createdAt: 10 },
      { role: "assistant", status: "done", createdAt: 20 },
    ])).toBe(false);
  });

  it("keeps the orb engaged for the current queued or streamed turn", () => {
    expect(isForegroundBusy([{ role: "user", status: "pending", createdAt: 10 }])).toBe(true);
    expect(isForegroundBusy([{ role: "assistant", status: "streaming", createdAt: 10 }])).toBe(true);
  });
});
