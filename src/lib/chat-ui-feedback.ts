export type CompactFeedbackPhase =
  | "online"
  | "connecting"
  | "listening"
  | "researching"
  | "thinking"
  | "responding"
  | "buffering"
  | "speaking"
  | "voice paused"
  | "voice unavailable";

type CompactCaption = { who: "you" | "jarvis"; text: string } | null;

const compactText = (text: string, limit = 180) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
};

/**
 * The collapsed embed has no message column, so it must explicitly surface the
 * optimistic speech/typed turn while Convex and the worker catch up.
 */
export function compactChatFeedback(input: {
  phase: CompactFeedbackPhase;
  caption: CompactCaption;
  latestUser?: string;
  latestAssistant?: string;
  assistantStreaming?: boolean;
}): string {
  const captionText = compactText(input.caption?.text ?? "");
  const latestUser = compactText(input.latestUser ?? "");
  const latestAssistant = compactText(input.latestAssistant ?? "");

  if (input.phase === "voice paused") return "Reply ready — tap the speaker to hear it.";
  if (input.phase === "voice unavailable") return "Reply is in chat — tap the speaker to retry audio.";
  if (input.assistantStreaming && latestAssistant) return latestAssistant;
  if (input.caption?.who === "jarvis" && captionText) return captionText;
  if (input.caption?.who === "you" && captionText) {
    if (/^(?:processing|listening)(?:…|\.\.\.)?$/i.test(captionText)) return captionText;
    return `You: ${captionText}`;
  }
  if ((input.phase === "thinking" || input.phase === "researching") && latestUser) {
    return `Working on: ${latestUser}`;
  }
  if (latestAssistant) return latestAssistant;
  return input.phase === "connecting" ? "Connecting securely…" : "Ready when you are.";
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Client-only visual progress: no polling, provider calls, or billing. */
export function foregroundUiProgress(input: {
  phase: CompactFeedbackPhase;
  elapsedMs: number;
  streamedChars?: number;
  researchReady?: boolean;
  recovery?: string;
}): number {
  const elapsed = Math.max(0, input.elapsedMs);
  if (input.recovery === "retry-ready" || input.recovery === "terminal" || input.recovery === "failed") return 0.98;
  if (input.recovery === "recovering" || input.recovery === "cancelling") return 0.76;
  switch (input.phase) {
    case "online": return 0;
    case "connecting": return 0.08;
    case "listening": return 0.16;
    case "researching": return input.researchReady ? 0.31 : clamp(0.22 + elapsed / 80_000, 0.22, 0.3);
    case "thinking": return clamp(0.3 + elapsed / 120_000, 0.3, 0.48);
    case "responding": {
      const textProgress = Math.max(0, input.streamedChars ?? 0) / 5_000;
      return clamp(0.5 + textProgress + elapsed / 300_000, 0.5, 0.86);
    }
    case "buffering": return 0.88;
    case "voice paused":
    case "voice unavailable": return 0.96;
    case "speaking": return 0.94;
  }
}

export function shouldOfferForegroundRecovery(input: {
  elapsedMs: number;
  hasActiveTurn: boolean;
  recovery: string;
}): boolean {
  if (input.recovery === "idle") return false;
  if (input.recovery !== "waiting") return true;
  return input.hasActiveTurn && input.elapsedMs >= 8_000;
}
