// Whisper occasionally returns the same complete utterance twice from one
// recording window. Remove only exact whole-utterance repetition; ordinary
// emphasis inside a sentence ("very, very good") is left alone.
export function cleanSpeechTranscript(input: string): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return "";

  const matches = [...text.matchAll(/[\p{L}\p{N}']+/gu)];
  const words = matches.map((match) => match[0].toLocaleLowerCase("en-GB"));
  for (let span = 2; span <= Math.floor(words.length / 2); span += 1) {
    if (words.length % span !== 0) continue;
    const repetitions = words.length / span;
    if (repetitions < 2) continue;
    const repeated = words.every((word, index) => word === words[index % span]);
    if (!repeated) continue;
    const secondStart = matches[span]?.index;
    if (secondStart == null) break;
    return text.slice(0, secondStart).trim().replace(/[\s,;:\-–—]+$/, "");
  }
  return text;
}

export function isMeaningfulSpeechTranscript(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  // Whisper returns punctuation-only fragments such as "." for room noise.
  // They previously became real turns and could restart a stale topic loop.
  return /[\p{L}\p{N}]/u.test(text);
}

export type SpeechSegmentEvidence = {
  start?: number;
  end?: number;
  avg_logprob?: number;
  no_speech_prob?: number;
};

export function hasConfidentSpeechSegments(input: unknown): boolean {
  if (!Array.isArray(input)) return true;
  if (!input.length) return false;
  return input.some((value) => {
    if (!value || typeof value !== "object") return false;
    const segment = value as SpeechSegmentEvidence;
    const noSpeech = Number(segment.no_speech_prob);
    const logProbability = Number(segment.avg_logprob);
    const duration = Number(segment.end) - Number(segment.start);
    if (Number.isFinite(noSpeech) && noSpeech >= 0.6) return false;
    if (Number.isFinite(logProbability) && logProbability <= -0.8) return false;
    if (Number.isFinite(duration) && duration < 0.16) return false;
    return true;
  });
}

export function isRecentVoiceDuplicate(
  input: string,
  previous: { text: string; at: number } | null,
  now = Date.now(),
): boolean {
  if (!previous) return false;
  const normalized = input.toLocaleLowerCase("en-GB").replace(/[^\p{L}\p{N}']+/gu, " ").trim();
  const prior = previous.text.toLocaleLowerCase("en-GB").replace(/[^\p{L}\p{N}']+/gu, " ").trim();
  if (!normalized || normalized !== prior) return false;
  const words = normalized.split(/\s+/).length;
  // False Whisper text often survives several silent recorder windows. Hold
  // exact repeats well beyond that retry cadence so an empty room cannot keep
  // resubmitting one stale command. Longer phrases use a shorter window so a
  // deliberately repeated instruction remains possible later in a session.
  return now - previous.at < (words <= 2 ? 5 * 60_000 : 90_000);
}
