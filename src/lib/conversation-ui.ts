import { advanceLiveConversation, type LiveConversationState } from "./live-conversation";
import { isPanelFollowUp, type ConversationPanel } from "./panel-context";

type RefCell<T> = { current: T };

export type LiveAssistantUiBridge = {
  sessionOwned: RefCell<boolean>;
  conversation: RefCell<LiveConversationState>;
  scheduleCapture: () => void;
};

export type FinalAssistantCursor = { thread: string; messageId: string | null } | null;

export type FinalAssistantObservation = {
  cursor: FinalAssistantCursor;
  messageId: string | null;
};

/**
 * Seed already-loaded history without replaying it, then surface every newly
 * finalized assistant message. Query readiness matters: an empty hydrated
 * thread must not mistake its first real reply for mount-time history.
 */
export function observeFinalAssistantMessage(
  cursor: FinalAssistantCursor,
  thread: string,
  queryReady: boolean,
  latestMessageId: string | null,
): FinalAssistantObservation {
  if (!queryReady) return { cursor, messageId: null };
  if (!cursor || cursor.thread !== thread) {
    return { cursor: { thread, messageId: latestMessageId }, messageId: null };
  }
  if (!latestMessageId || cursor.messageId === latestMessageId) return { cursor, messageId: null };
  return { cursor: { thread, messageId: latestMessageId }, messageId: latestMessageId };
}

/**
 * Complete one assistant turn without surrendering the live-session ticker.
 * The browser session remains the owner; only the next recorder turn is
 * scheduled here.
 */
export function rearmLiveCaptureAfterAssistant(bridge: LiveAssistantUiBridge, now: number): boolean {
  if (!bridge.sessionOwned.current || bridge.conversation.current.phase !== "awaiting-assistant") return false;
  bridge.conversation.current = advanceLiveConversation(bridge.conversation.current, {
    type: "assistant-finished",
    now,
  });
  if (!bridge.conversation.current.active || bridge.conversation.current.phase !== "listening") return false;
  bridge.scheduleCapture();
  return true;
}

/** Keep the foreground TTS bridge's completion signal reliable on every path. */
export async function runAssistantUiTurn(work: () => Promise<void>, onFinished: () => void): Promise<void> {
  try {
    await work();
  } finally {
    onFinished();
  }
}

export type ConversationOverlayActions = {
  moveVideoToPip: () => void;
  markDismissed: (key: string, at: number) => void;
  cancelPendingPanels: () => void;
  hideStage: () => void;
  exitFullscreen: () => void;
  clearOptimisticPanel: () => void;
  removeFromHistory: (key: string) => void;
  clearRemotePanel: () => Promise<unknown>;
};

export type ConversationOverlayResult = "none" | "retained" | "video-pip" | "cleared";

export function conversationPanelKey(panel: ConversationPanel): string {
  return `${panel.title ?? ""}|${panel.value.slice(0, 160)}`;
}

/**
 * Apply the complete UI/context cleanup before dispatching a new-topic turn.
 * A contextual follow-up is a no-op, while videos preserve their established
 * picture-in-picture lifecycle.
 */
export async function disciplineConversationOverlay(
  message: string,
  panel: ConversationPanel | null | undefined,
  actions: ConversationOverlayActions,
  now: number,
): Promise<ConversationOverlayResult> {
  if (!panel) return "none";
  if (panel.type === "video") {
    actions.moveVideoToPip();
    return "video-pip";
  }
  if (isPanelFollowUp(message, panel)) return "retained";

  const key = conversationPanelKey(panel);
  actions.markDismissed(key, now);
  actions.cancelPendingPanels();
  actions.hideStage();
  actions.exitFullscreen();
  actions.clearOptimisticPanel();
  actions.removeFromHistory(key);
  try {
    await actions.clearRemotePanel();
  } catch {
    // A transient context-clear failure must not block the conversational turn.
  }
  return "cleared";
}
