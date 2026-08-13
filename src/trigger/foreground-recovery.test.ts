import { describe, expect, it, vi } from "vitest";
import { dispatchPendingForegroundRecovery } from "./foreground-recovery";

describe("foreground pre-claim recovery dispatch", () => {
  it("uses the queue's bounded recovery receipt before waking Trigger", async () => {
    const requestRecovery = vi.fn().mockResolvedValue({
      status: "pending",
      messageId: "message-1",
      dispatchEpoch: 2,
    });
    const trigger = vi.fn().mockResolvedValue({ id: "run-1" });

    await expect(dispatchPendingForegroundRecovery({ messageId: "message-1", threadId: "travel" }, { requestRecovery, trigger }))
      .resolves.toEqual({
        status: "pending",
        dispatched: true,
        messageId: "message-1",
        dispatchEpoch: 2,
        runId: "run-1",
      });
    expect(requestRecovery).toHaveBeenCalledWith({ messageId: "message-1", threadId: "travel" });
    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger).toHaveBeenCalledWith("message-1", 2);
  });

  it("does not create another task after the durable queue has closed recovery", async () => {
    const requestRecovery = vi.fn().mockResolvedValue({ status: "failed" });
    const trigger = vi.fn();

    await expect(dispatchPendingForegroundRecovery({ messageId: "message-1", threadId: "main" }, { requestRecovery, trigger }))
      .resolves.toEqual({ status: "failed", dispatched: false });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("fails closed when a recoverable receipt lacks its bounded wake identity", async () => {
    const requestRecovery = vi.fn().mockResolvedValue({
      status: "pending",
      messageId: "message-1",
      dispatchEpoch: 0,
    });
    const trigger = vi.fn();

    await expect(dispatchPendingForegroundRecovery({ messageId: "message-1", threadId: "main" }, { requestRecovery, trigger }))
      .resolves.toEqual({
        status: "pending",
        dispatched: false,
        reason: "invalid-recovery-receipt",
      });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("fails closed without an exact thread scope", async () => {
    const requestRecovery = vi.fn();
    const trigger = vi.fn();

    await expect(dispatchPendingForegroundRecovery({ messageId: "message-1", threadId: "" }, { requestRecovery, trigger }))
      .resolves.toEqual({
        status: "invalid",
        dispatched: false,
        reason: "invalid-recovery-receipt",
      });
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
});
