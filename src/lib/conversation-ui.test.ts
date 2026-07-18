import { describe, expect, it, vi } from "vitest";
import {
  conversationPanelKey,
  disciplineConversationOverlay,
  observeFinalAssistantMessage,
  rearmLiveCaptureAfterAssistant,
  runAssistantUiTurn,
  type FinalAssistantCursor,
  type ConversationOverlayActions,
} from "./conversation-ui";
import { advanceLiveConversation, inactiveLiveConversation } from "./live-conversation";
import type { ConversationPanel } from "./panel-context";

const bitcoinChart: ConversationPanel = {
  type: "widget",
  title: "BTC · 1h",
  value: JSON.stringify({ kind: "candles", asset: "BTC", interval: "1h" }),
};

function overlayActions(): ConversationOverlayActions {
  return {
    moveVideoToPip: vi.fn(),
    markDismissed: vi.fn(),
    cancelPendingPanels: vi.fn(),
    hideStage: vi.fn(),
    exitFullscreen: vi.fn(),
    clearOptimisticPanel: vi.fn(),
    removeFromHistory: vi.fn(),
    clearRemotePanel: vi.fn(async () => undefined),
  };
}

describe("conversation UI bridge", () => {
  it("re-arms browser capture after the first and consecutive assistant turns, including TTS failure", async () => {
    const sessionOwned = { current: true };
    const conversation = {
      current: advanceLiveConversation(inactiveLiveConversation(), { type: "start", now: 0 }),
    };
    const scheduleCapture = vi.fn();
    const bridge = { sessionOwned, conversation, scheduleCapture };
    let cursor: FinalAssistantCursor = null;

    const observeReply = async (messageId: string, now: number, fail = false) => {
      const observation = observeFinalAssistantMessage(cursor, "main", true, messageId);
      cursor = observation.cursor;
      if (!observation.messageId) return;
      await runAssistantUiTurn(
        async () => {
          if (fail) throw new Error("tts unavailable");
        },
        () => rearmLiveCaptureAfterAssistant(bridge, now),
      );
    };

    // Loading is not history. Once an empty thread has hydrated, its first
    // completed response must flow through the same production completion gate.
    cursor = observeFinalAssistantMessage(cursor, "main", false, null).cursor;
    cursor = observeFinalAssistantMessage(cursor, "main", true, null).cursor;

    conversation.current = advanceLiveConversation(conversation.current, { type: "speech-accepted", now: 1_000 });
    await observeReply("reply-1", 2_000);

    conversation.current = advanceLiveConversation(conversation.current, { type: "speech-accepted", now: 3_000 });
    await expect(observeReply("reply-2", 4_000, true)).rejects.toThrow("tts unavailable");

    expect(sessionOwned.current).toBe(true);
    expect(conversation.current).toMatchObject({ active: true, phase: "listening", completedTurns: 2 });
    expect(scheduleCapture).toHaveBeenCalledTimes(2);
  });

  it("seeds existing thread history without replaying it", () => {
    const initial = observeFinalAssistantMessage(null, "main", true, "historic-reply");
    expect(initial.messageId).toBeNull();

    const next = observeFinalAssistantMessage(initial.cursor, "main", true, "new-reply");
    expect(next.messageId).toBe("new-reply");

    const threadHop = observeFinalAssistantMessage(next.cursor, "planning", true, "planning-history");
    expect(threadHop.messageId).toBeNull();
  });

  it("does not re-arm capture after an intentional session stop", async () => {
    const sessionOwned = { current: true };
    const conversation = {
      current: advanceLiveConversation(inactiveLiveConversation(), { type: "start", now: 0 }),
    };
    const scheduleCapture = vi.fn();
    const bridge = { sessionOwned, conversation, scheduleCapture };

    conversation.current = advanceLiveConversation(conversation.current, { type: "speech-accepted", now: 1_000 });
    conversation.current = advanceLiveConversation(conversation.current, { type: "explicit-stop", now: 2_000 });
    sessionOwned.current = false;
    await runAssistantUiTurn(
      async () => undefined,
      () => rearmLiveCaptureAfterAssistant(bridge, 3_000),
    );

    expect(conversation.current).toMatchObject({ active: false, phase: "off", completedTurns: 0 });
    expect(scheduleCapture).not.toHaveBeenCalled();
  });

  it("hides and clears a stale Bitcoin overlay before an unrelated turn continues", async () => {
    const actions = overlayActions();
    let releaseRemoteClear: (() => void) | undefined;
    const remoteClear = new Promise<void>((resolve) => {
      releaseRemoteClear = resolve;
    });
    vi.mocked(actions.clearRemotePanel).mockReturnValue(remoteClear);

    const result = disciplineConversationOverlay(
      "What's the weather in Lisbon tomorrow?",
      bitcoinChart,
      actions,
      9_000,
    );
    const key = conversationPanelKey(bitcoinChart);

    // Local stage, pending foreground panels, and landscape-orb history are
    // disciplined synchronously, before the Convex mutation round-trip.
    expect(actions.markDismissed).toHaveBeenCalledWith(key, 9_000);
    expect(actions.cancelPendingPanels).toHaveBeenCalledOnce();
    expect(actions.hideStage).toHaveBeenCalledOnce();
    expect(actions.exitFullscreen).toHaveBeenCalledOnce();
    expect(actions.clearOptimisticPanel).toHaveBeenCalledOnce();
    expect(actions.removeFromHistory).toHaveBeenCalledWith(key);
    expect(actions.clearRemotePanel).toHaveBeenCalledOnce();

    releaseRemoteClear?.();
    await expect(result).resolves.toBe("cleared");
  });

  it("retains a Bitcoin overlay for a meaningful contextual follow-up", async () => {
    const actions = overlayActions();

    await expect(disciplineConversationOverlay("What does this move mean?", bitcoinChart, actions, 9_000)).resolves.toBe(
      "retained",
    );

    expect(actions.markDismissed).not.toHaveBeenCalled();
    expect(actions.cancelPendingPanels).not.toHaveBeenCalled();
    expect(actions.hideStage).not.toHaveBeenCalled();
    expect(actions.removeFromHistory).not.toHaveBeenCalled();
    expect(actions.clearRemotePanel).not.toHaveBeenCalled();
  });

  it("preserves the existing video picture-in-picture lifecycle", async () => {
    const actions = overlayActions();
    const video: ConversationPanel = { type: "video", title: "Launch trailer", value: "https://youtu.be/example" };

    await expect(disciplineConversationOverlay("Tell me about Lisbon", video, actions, 9_000)).resolves.toBe("video-pip");

    expect(actions.moveVideoToPip).toHaveBeenCalledOnce();
    expect(actions.hideStage).not.toHaveBeenCalled();
    expect(actions.clearRemotePanel).not.toHaveBeenCalled();
  });
});
