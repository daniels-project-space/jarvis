export type VoiceCaptureOutcome = "speech" | "silence" | "empty" | "echo" | "failure";
export type VoiceLoopAction = "await-reply" | "listen" | "stop";

/** Pure state transition for the browser's turn-taking microphone loop. */
export function nextVoiceLoopAction(args: {
  outcome: VoiceCaptureOutcome;
  persistentLive: boolean;
  loopRequested: boolean;
}): VoiceLoopAction {
  if (!args.loopRequested) return "stop";
  if (args.outcome === "speech") return "await-reply";
  if (
    args.persistentLive &&
    (args.outcome === "silence" || args.outcome === "empty" || args.outcome === "echo")
  ) {
    return "listen";
  }
  return "stop";
}
