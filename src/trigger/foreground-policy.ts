// Foreground conversation is deliberately a short, parallel lane. Durable
// research/coding belongs to jarvis-agent-runner; a slow chat turn must never
// inherit that runner's hour/day lifecycle or monopolise Daniel's only voice.
export const FOREGROUND_QUEUE = "jarvis-foreground";
export const FOREGROUND_CONCURRENCY = 6;
export const FOREGROUND_TURN_TIMEOUT_MS = 150_000;
export const FOREGROUND_MAX_DURATION_SECONDS = 300;

export type ForegroundTurnPayload = {
  messageId?: string;
  threadId?: string;
  source?: string;
};
