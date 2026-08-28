// A voice turn already paid for endpointing and transcription before the
// foreground model starts streaming. Once it has produced a speakable clause,
// favour first audible feedback over waiting for a slightly longer TTS unit.
// Typed chat retains the longer coalescing window for natural cadence.
export const VOICE_FIRST_STABLE_SPEECH_DEBOUNCE_MS = 120;
export const DEFAULT_STABLE_SPEECH_DEBOUNCE_MS = 220;

export function stableSpeechDebounceMs(input: {
  voiceTurn: boolean;
  scheduledChars: number;
}): number {
  return input.voiceTurn && input.scheduledChars === 0
    ? VOICE_FIRST_STABLE_SPEECH_DEBOUNCE_MS
    : DEFAULT_STABLE_SPEECH_DEBOUNCE_MS;
}
