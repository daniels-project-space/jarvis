export const FOREGROUND_THINKING_TEXT = "Thinking…";

export type ForegroundTurnMessage = {
  _id: string;
  role: string;
  status: string;
  requestId?: string;
  parentMessageId?: string;
  delivery?: "foreground" | "notification";
};

export function assistantForRequest<T extends ForegroundTurnMessage>(
  messages: readonly T[],
  requestId: string,
): T | undefined {
  const user = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.requestId === requestId);
  if (!user) return undefined;
  return [...messages]
    .reverse()
    .find((message) =>
      message.role === "assistant" &&
      message.delivery !== "notification" &&
      message.parentMessageId === user._id,
    );
}

export function requestIdForAssistant<T extends ForegroundTurnMessage>(
  messages: readonly T[],
  assistant: T,
): string | undefined {
  if (!assistant.parentMessageId) return undefined;
  return messages.find((message) => message._id === assistant.parentMessageId)?.requestId;
}
