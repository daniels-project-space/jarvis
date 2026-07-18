export const LIVE_CONVERSATION_IDLE_MS = 60_000;

export type LiveConversationState = {
  active: boolean;
  phase: "off" | "listening" | "awaiting-assistant";
  startedAt: number;
  lastSpeechAt: number;
  completedTurns: number;
};

export type LiveConversationEvent =
  | { type: "start"; now: number }
  | { type: "speech-accepted"; now: number }
  | { type: "assistant-finished"; now: number }
  | { type: "no-speech"; now: number }
  | { type: "transcript-rejected"; now: number }
  | { type: "capture-retryable-error"; now: number }
  | { type: "explicit-stop"; now: number }
  | { type: "permission-lost"; now: number }
  | { type: "lease-lost"; now: number }
  | { type: "page-hidden"; now: number };

export function inactiveLiveConversation(): LiveConversationState {
  return { active: false, phase: "off", startedAt: 0, lastSpeechAt: 0, completedTurns: 0 };
}

/**
 * The live conversation is a session, not a single recorder/model/TTS turn.
 * Only deliberate lifecycle events (or the documented idle timeout) end it;
 * ordinary capture and transcription misses leave the session listening.
 */
export function advanceLiveConversation(
  state: LiveConversationState,
  event: LiveConversationEvent,
): LiveConversationState {
  if (event.type === "start") {
    return {
      active: true,
      phase: "listening",
      startedAt: event.now,
      lastSpeechAt: event.now,
      completedTurns: 0,
    };
  }

  if (!state.active) return state;

  switch (event.type) {
    case "speech-accepted":
      return { ...state, phase: "awaiting-assistant", lastSpeechAt: event.now };
    case "assistant-finished":
      return {
        ...state,
        phase: "listening",
        completedTurns: state.completedTurns + (state.phase === "awaiting-assistant" ? 1 : 0),
      };
    case "no-speech":
      if (event.now - state.lastSpeechAt >= LIVE_CONVERSATION_IDLE_MS) {
        return { ...state, active: false, phase: "off" };
      }
      return { ...state, phase: "listening" };
    case "transcript-rejected":
    case "capture-retryable-error":
      return { ...state, phase: "listening" };
    case "explicit-stop":
    case "permission-lost":
    case "lease-lost":
    case "page-hidden":
      return { ...state, active: false, phase: "off" };
  }
}
