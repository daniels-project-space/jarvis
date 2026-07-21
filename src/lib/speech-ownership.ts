export type SpeechCaption = {
  who: "you" | "jarvis";
  text: string;
  phase?: "streaming" | "ready" | "speaking";
  exiting?: boolean;
} | null;

/**
 * Final delivery owns precisely the part not already committed to the
 * streamed narration. If sanitising a completed answer changes its prefix,
 * the completed answer owns the whole phrase rather than slicing at an
 * unrelated character offset.
 */
export function finalSpeechSuffix(finalText: string, streamedPrefix: string): string {
  if (!streamedPrefix || !finalText.startsWith(streamedPrefix)) return finalText.trim();
  return finalText.slice(streamedPrefix.length).trim();
}

/** Keep one caption surface through streaming, speech and final delivery. */
export function retainCaption(current: SpeechCaption, incoming: SpeechCaption): SpeechCaption {
  if (!incoming) return null;
  if (current?.who === incoming.who) {
    return { ...current, ...incoming, phase: incoming.phase ?? "ready", exiting: false };
  }
  return { ...incoming, phase: incoming.phase ?? "ready", exiting: false };
}
