import { describe, expect, it } from "vitest";
import { foregroundTurnPhase, latestRecoverableForegroundTurn } from "./foreground-recovery";

const userId = "user-1";

describe("foregroundTurnPhase", () => {
  it("tracks a turn by parent identity instead of a later unrelated reply", () => {
    expect(foregroundTurnPhase([
      { role: "assistant", status: "done", text: "later", parentMessageId: "user-2" },
      { role: "assistant", status: "streaming", text: "partial", parentMessageId: userId },
    ], userId)).toEqual({ phase: "streaming", text: "partial" });
  });

  it("treats a fenced attempt as queued until its replacement is claimed", () => {
    expect(foregroundTurnPhase([
      { role: "assistant", status: "superseded", text: "", parentMessageId: userId },
    ], userId)).toEqual({ phase: "queued", text: "" });
  });

  it("surfaces terminal failures instead of leaving the composer busy", () => {
    expect(foregroundTurnPhase([
      { role: "assistant", status: "error", text: "recovery failed", parentMessageId: userId },
    ], userId)).toEqual({ phase: "error", text: "recovery failed" });
  });
});

describe("latestRecoverableForegroundTurn", () => {
  it("restores the newest durable pending or streaming turn after reload", () => {
    expect(latestRecoverableForegroundTurn([
      { id: "u1", role: "user", status: "done", text: "old" },
      { id: "a1", role: "assistant", status: "done", text: "done", parentMessageId: "u1" },
      { id: "u2", role: "user", status: "done", text: "still working" },
      { id: "a2", role: "assistant", status: "streaming", text: "partial", parentMessageId: "u2" },
    ])).toEqual({ messageId: "u2", text: "still working" });
  });

  it("does not restore completed or failed turns", () => {
    expect(latestRecoverableForegroundTurn([
      { id: "u1", role: "user", status: "error", text: "failed" },
      { id: "a1", role: "assistant", status: "error", text: "failed", parentMessageId: "u1" },
    ])).toBeNull();
  });
});
