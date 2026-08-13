export type PendingForegroundRecoveryReceipt = {
  status?: unknown;
  messageId?: unknown;
  dispatchEpoch?: unknown;
};

export type PendingForegroundSignal = {
  messageId: string;
  threadId: string;
};

export type PendingForegroundRecoveryResult = {
  status: string;
  dispatched: boolean;
  messageId?: string;
  dispatchEpoch?: number;
  runId?: string;
  reason?: "invalid-recovery-receipt";
};

type RecoveryDependencies = {
  requestRecovery: (signal: PendingForegroundSignal) => Promise<unknown>;
  trigger: (messageId: string, dispatchEpoch: number) => Promise<{ id: string }>;
};

// A startup failure happens before a worker has claimed the durable turn. The
// queue's recovery mutation is the authority for bounding those wake attempts;
// dispatching Trigger directly would leave dispatchEpoch unchanged forever.
export async function dispatchPendingForegroundRecovery(
  signal: PendingForegroundSignal,
  dependencies: RecoveryDependencies,
): Promise<PendingForegroundRecoveryResult> {
  if (!signal.messageId || !signal.threadId) {
    return { status: "invalid", dispatched: false, reason: "invalid-recovery-receipt" };
  }
  const rawReceipt = await dependencies.requestRecovery(signal);
  const receipt = rawReceipt && typeof rawReceipt === "object"
    ? rawReceipt as PendingForegroundRecoveryReceipt
    : {};
  const status = typeof receipt.status === "string" ? receipt.status : "invalid";
  if (status !== "pending" && status !== "requeued") {
    return { status, dispatched: false };
  }

  const messageId = typeof receipt.messageId === "string" ? receipt.messageId : "";
  const dispatchEpoch = Number(receipt.dispatchEpoch);
  if (!messageId || !Number.isSafeInteger(dispatchEpoch) || dispatchEpoch < 1) {
    return { status, dispatched: false, reason: "invalid-recovery-receipt" };
  }

  const run = await dependencies.trigger(messageId, dispatchEpoch);
  return {
    status,
    dispatched: true,
    messageId,
    dispatchEpoch,
    runId: run.id,
  };
}
