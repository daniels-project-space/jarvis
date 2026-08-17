import { describe, expect, it } from "vitest";
import {
  authoritativeCancellationReceipt,
  foregroundRecoveryBudgetAfterSignal,
  foregroundRecoveryWatchdogDisposition,
  foregroundTurnPhase,
  latestRecoverableForegroundTurn,
  mergeRecoveredAssistant,
  terminalDurableRecoveryOutcome,
} from "./foreground-recovery";

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

describe("authoritativeCancellationReceipt", () => {
  it("accepts only the exact turn's committed fence receipt", () => {
    expect(authoritativeCancellationReceipt({
      ok: true,
      cancellation: "cancelled",
      messageId: userId,
      fenceReceipt: "receipt-123",
    }, userId)).toBe("receipt-123");
  });

  it.each([
    { ok: false, cancellation: "cancelled", messageId: userId, fenceReceipt: "receipt-123" },
    { ok: true, cancellation: "pending", messageId: userId, fenceReceipt: "receipt-123" },
    { ok: true, cancellation: "cancelled", messageId: "another-turn", fenceReceipt: "receipt-123" },
    { ok: true, cancellation: "cancelled", messageId: userId, fenceReceipt: "" },
  ])("rejects an ambiguous or mismatched response before retry", (response) => {
    expect(authoritativeCancellationReceipt(response, userId)).toBeNull();
  });
});

describe("mergeRecoveredAssistant", () => {
  it("delivers a completed recovery once, then yields to the reactive row", () => {
    const recovered = { _id: "a2", createdAt: 3, text: "recovered" };
    const initial = [{ _id: "u2", createdAt: 2, text: "question" }];

    expect(mergeRecoveredAssistant(initial, recovered)).toEqual([...initial, recovered]);
    const reactive = [...initial, { ...recovered, text: "authoritative" }];
    expect(mergeRecoveredAssistant(reactive, recovered)).toBe(reactive);
  });
});

describe("terminalDurableRecoveryOutcome", () => {
  it("does not resolve a transition while the turn is still in flight", () => {
    expect(terminalDurableRecoveryOutcome("queued")).toBeNull();
    expect(terminalDurableRecoveryOutcome("streaming")).toBeNull();
  });

  it("releases the composer and clears the tracked turn on a completed reply", () => {
    expect(terminalDurableRecoveryOutcome("done")).toEqual({
      clearActiveTurn: true,
      sending: false,
      durableRecovery: "idle",
    });
  });

  it("regression: a backend-finalized failure also releases the composer instead of leaving it stuck on 'thinking'", () => {
    // Before the fix, the error branch returned `sending: true` and never
    // cleared the active turn, so the UI stayed on the busy/"thinking"
    // indicator forever once chatQueue.ts finalized a turn as errored.
    expect(terminalDurableRecoveryOutcome("error")).toEqual({
      clearActiveTurn: true,
      sending: false,
      durableRecovery: "failed",
    });
  });
});

describe("foreground recovery watchdog races", () => {
  it("does not spend retry budget while a healthy stream remains active", () => {
    let attempts = 0;
    for (let heartbeat = 0; heartbeat < 12; heartbeat += 1) {
      attempts += 1;
      attempts = foregroundRecoveryBudgetAfterSignal(attempts, "active");
      expect(foregroundRecoveryWatchdogDisposition(attempts)).toBe("arm");
    }
    expect(attempts).toBe(0);
  });

  it("pauses automatic recovery without authorizing cancellation after bounded failures", () => {
    let attempts = 0;
    for (let failure = 0; failure < 3; failure += 1) {
      attempts += 1;
      attempts = foregroundRecoveryBudgetAfterSignal(attempts, "failed");
    }
    expect(foregroundRecoveryWatchdogDisposition(attempts)).toBe("pause");
  });
});
