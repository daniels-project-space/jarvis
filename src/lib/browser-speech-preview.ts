export const BROWSER_SPEECH_FINAL_MIN_CONFIDENCE = 0.88;

export type BrowserSpeechPreview = {
  sessionId: string;
  text: string;
  isFinal: boolean;
  confidence: number;
  observedVoiceAt: number;
};

export type LiveTranscriptSource =
  | { source: "browser-final"; text: string }
  | { source: "server" };

function normalized(text: string): string {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

function words(text: string): string[] {
  return normalized(text)
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Browser interim speech may inform read-only preview work only after the next
 * same-session revision proves that the earlier words remained an exact prefix.
 */
export function isStableBrowserSpeechRevision(
  previous: BrowserSpeechPreview | null,
  current: BrowserSpeechPreview,
): boolean {
  if (!previous || previous.sessionId !== current.sessionId) return false;
  if (current.observedVoiceAt < previous.observedVoiceAt) return false;
  const previousWords = words(previous.text);
  const currentWords = words(current.text);
  if (!previousWords.length || currentWords.length <= previousWords.length) return false;
  return previousWords.every((word, index) => currentWords[index] === word);
}

/**
 * If both server recognizers are temporarily unavailable, a fenced browser
 * preview may rescue the already-recorded utterance instead of asking the user
 * to repeat it. This recovery threshold is intentionally stricter for an
 * interim result: it must have survived an exact longer revision.
 */
export function recoverLiveTranscriptFromBrowser(args: {
  previous: BrowserSpeechPreview | null;
  preview: BrowserSpeechPreview | null;
  sessionId: string;
  currentVoiceAt: number;
  sessionActive: boolean;
}): string {
  const preview = args.preview;
  const text = normalized(preview?.text ?? "");
  if (
    !args.sessionActive
    || !preview
    || preview.sessionId !== args.sessionId
    || preview.observedVoiceAt !== args.currentVoiceAt
    || !text
  ) return "";
  const usableFinal = preview.isFinal
    && Number.isFinite(preview.confidence)
    && preview.confidence >= 0.55;
  return usableFinal || isStableBrowserSpeechRevision(args.previous, preview) ? text : "";
}

/**
 * Server STT is the default. A browser transcript can replace the one allowed
 * server request only when it is final, strongly confident, tied to this exact
 * live session, and no VAD-accepted speech occurred after that final result.
 */
export function chooseLiveTranscriptSource(args: {
  preview: BrowserSpeechPreview | null;
  sessionId: string;
  currentVoiceAt: number;
  sessionActive: boolean;
}): LiveTranscriptSource {
  const preview = args.preview;
  const text = normalized(preview?.text ?? "");
  if (
    !args.sessionActive
    || !preview
    || preview.sessionId !== args.sessionId
    || !preview.isFinal
    || !Number.isFinite(preview.confidence)
    || preview.confidence < BROWSER_SPEECH_FINAL_MIN_CONFIDENCE
    || preview.observedVoiceAt !== args.currentVoiceAt
    || !text
  ) return { source: "server" };
  return { source: "browser-final", text };
}
