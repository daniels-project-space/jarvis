import type { CodexConversationHandoff } from "./codex-app-server";

// Foreground conversation is deliberately a short, parallel lane. Durable
// research/coding belongs to the independent agent fleet; a slow background
// run must never inherit or monopolise Daniel's foreground voice lane.
export const FOREGROUND_QUEUE = "jarvis-foreground";
export const FOREGROUND_CONCURRENCY = 2;
export const FOREGROUND_TURN_TIMEOUT_MS = 150_000;
export const FOREGROUND_MAX_DURATION_SECONDS = 900;

export type ForegroundTurnPayload = {
  messageId?: string;
  threadId?: string;
  source?: string;
  handoffFrom?: string;
  handoffConversations?: CodexConversationHandoff[];
};
