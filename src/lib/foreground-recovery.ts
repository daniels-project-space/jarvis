export const FOREGROUND_AUTO_RECOVERY_MS = 15_000;

export type ForegroundMessageState = {
  role: string;
  status: string;
  text: string;
  parentMessageId?: string;
};

export type ForegroundTurnPhase = "queued" | "streaming" | "done" | "error";

export type RecoverableForegroundTurn = {
  messageId: string;
  text: string;
};

export type ForegroundCancellationResponse = {
  ok?: unknown;
  cancellation?: unknown;
  messageId?: unknown;
  fenceReceipt?: unknown;
};

export type ForegroundRecoverySignal =
  | "active"
  | "streaming"
  | "completed"
  | "pending"
  | "requeued"
  | "failed";

export function foregroundRecoveryBudgetAfterSignal(
  attempts: number,
  signal: ForegroundRecoverySignal,
): number {
  return signal === "active" || signal === "streaming" || signal === "completed"
    ? 0
    : Math.max(0, attempts);
}

export function foregroundRecoveryWatchdogDisposition(
  attempts: number,
  maxAttempts = 3,
): "arm" | "pause" {
  return attempts >= maxAttempts ? "pause" : "arm";
}

export function mergeRecoveredAssistant<T extends { _id: string; createdAt: number }>(
  messages: T[],
  recovered: T | null,
): T[] {
  if (!recovered || messages.some((message) => message._id === recovered._id)) return messages;
  return [...messages, recovered].sort((left, right) => left.createdAt - right.createdAt);
}

export function authoritativeCancellationReceipt(
  response: ForegroundCancellationResponse,
  expectedMessageId: string,
): string | null {
  if (
    response.ok !== true ||
    response.cancellation !== "cancelled" ||
    response.messageId !== expectedMessageId ||
    typeof response.fenceReceipt !== "string"
  ) return null;
  const receipt = response.fenceReceipt.trim();
  return receipt.length >= 8 && receipt.length <= 512 ? receipt : null;
}

export function foregroundTurnPhase(
  messages: ForegroundMessageState[],
  parentMessageId: string,
): { phase: ForegroundTurnPhase; text: string } {
  const assistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.parentMessageId === parentMessageId);
  if (!assistant || assistant.status === "superseded") return { phase: "queued", text: "" };
  if (assistant.status === "streaming") return { phase: "streaming", text: assistant.text };
  if (assistant.status === "done") return { phase: "done", text: assistant.text };
  return { phase: "error", text: assistant.text };
}

export function latestRecoverableForegroundTurn(
  messages: Array<ForegroundMessageState & { id: string }>,
): RecoverableForegroundTurn | null {
  const assistantsByParent = new Map<string, ForegroundMessageState>();
  for (const message of messages) {
    if (message.role === "assistant" && message.parentMessageId) {
      assistantsByParent.set(message.parentMessageId, message);
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const assistant = assistantsByParent.get(message.id);
    if (message.status === "pending" || assistant?.status === "streaming") {
      return { messageId: message.id, text: message.text };
    }
  }
  return null;
}
