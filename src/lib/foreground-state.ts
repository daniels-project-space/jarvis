export type ForegroundMessageState = {
  role: string;
  status: string;
  delivery?: string;
  createdAt: number;
};

/**
 * Only the newest foreground turn can animate the orb as thinking. Older
 * transcript rows are history, even if a stale transport state survived a
 * deploy; the worker-side reaper resolves those separately.
 */
export function isForegroundBusy(messages: readonly ForegroundMessageState[]): boolean {
  const current = messages
    .filter((message) => message.delivery !== "notification")
    .reduce<ForegroundMessageState | null>((latest, message) =>
      !latest || message.createdAt > latest.createdAt ? message : latest,
    null);
  return current?.status === "pending"
    || (current?.role === "assistant" && current.status === "streaming");
}
