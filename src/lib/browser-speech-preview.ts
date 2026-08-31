export const BROWSER_SPEECH_FINAL_MIN_CONFIDENCE = 0.88;
// Chromium often emits its final Web Speech result just after MediaRecorder's
// stop event. Waiting a tiny, bounded tail is much cheaper than immediately
// paying the normal ~2s server-STT round trip.
export const BROWSER_SPEECH_FINAL_SETTLE_MS = 180;

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

export async function waitForBrowserSpeechFinal(args: {
  enabled: boolean;
  current: () => BrowserSpeechPreview | null;
  subscribe: (notify: () => void) => () => void;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!args.enabled) return false;
  if (args.current()?.isFinal === true) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(args.current()?.isFinal === true),
      args.timeoutMs ?? BROWSER_SPEECH_FINAL_SETTLE_MS,
    );
    const cleanup = args.subscribe(() => finish(args.current()?.isFinal === true));
    unsubscribe = cleanup;
    if (settled) cleanup();
    else if (args.current()?.isFinal === true) finish(true);
  });
}

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
 * Chromium commonly reports a final Web Speech result with confidence `0`,
 * which means "not supplied" rather than "known to be wrong". That result is
 * usable only when the immediately preceding same-session revision already
 * contained the exact final words (or an exact prefix) and no newer VAD frame
 * appeared. Callers still decide whether the utterance is safe enough for this
 * narrow path; mutating commands must retain authoritative server STT.
 */
export function isStableBrowserFinalRevision(
  previous: BrowserSpeechPreview | null,
  current: BrowserSpeechPreview,
): boolean {
  if (!previous || !current.isFinal || previous.sessionId !== current.sessionId) return false;
  if (current.observedVoiceAt < previous.observedVoiceAt) return false;
  const previousText = normalized(previous.text);
  const currentText = normalized(current.text);
  if (!previousText || !currentText) return false;
  return previousText === currentText || isStableBrowserSpeechRevision(previous, current);
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
  allowBrowserRecovery?: boolean;
}): string {
  const preview = args.preview;
  const text = normalized(preview?.text ?? "");
  if (
    !args.sessionActive
    || args.allowBrowserRecovery !== true
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
 * server request only when it is final, strongly confident, explicitly
 * admitted as read-only, tied to this exact live session, and no VAD-accepted
 * speech occurred after that final result.
 */
export function chooseLiveTranscriptSource(args: {
  previous?: BrowserSpeechPreview | null;
  preview: BrowserSpeechPreview | null;
  sessionId: string;
  currentVoiceAt: number;
  sessionActive: boolean;
  allowBrowserFinalTranscript?: boolean;
  allowStableFinalWithoutConfidence?: boolean;
}): LiveTranscriptSource {
  const preview = args.preview;
  const text = normalized(preview?.text ?? "");
  const strongConfidence = Boolean(
    preview
    && Number.isFinite(preview.confidence)
    && preview.confidence >= BROWSER_SPEECH_FINAL_MIN_CONFIDENCE,
  );
  const stableUnknownConfidence = Boolean(
    preview
    && args.allowStableFinalWithoutConfidence === true
    && preview.confidence === 0
    && isStableBrowserFinalRevision(args.previous ?? null, preview),
  );
  if (
    !args.sessionActive
    || args.allowBrowserFinalTranscript !== true
    || !preview
    || preview.sessionId !== args.sessionId
    || !preview.isFinal
    || (!strongConfidence && !stableUnknownConfidence)
    || preview.observedVoiceAt !== args.currentVoiceAt
    || !text
  ) return { source: "server" };
  return { source: "browser-final", text };
}
