import { isMeaningfulSpeechTranscript } from "./transcript";

export type FinalLiveTranscript = {
  text: string;
  source: "recorded" | "browser-final" | "streaming" | "none";
};

/**
 * The tiny streaming recognizer exists to make partial feedback immediate; it
 * is not accurate enough to overrule a completed Whisper pass. Keep the final
 * authority order explicit so a plausible-looking Zipformer hallucination can
 * never suppress a better recording transcript.
 */
export function selectFinalLiveTranscript(args: {
  recordedText: string;
  browserFinalText?: string;
  streamedText: string;
}): FinalLiveTranscript {
  if (isMeaningfulSpeechTranscript(args.recordedText)) {
    return { text: args.recordedText.trim(), source: "recorded" };
  }
  if (isMeaningfulSpeechTranscript(args.browserFinalText ?? "")) {
    return { text: args.browserFinalText!.trim(), source: "browser-final" };
  }
  if (isMeaningfulSpeechTranscript(args.streamedText)) {
    return { text: args.streamedText.trim(), source: "streaming" };
  }
  return { text: "", source: "none" };
}
