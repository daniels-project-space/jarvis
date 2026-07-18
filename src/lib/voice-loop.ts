export type VoiceCaptureOutcome = "speech" | "silence" | "empty" | "echo" | "failure";
export type VoiceLoopAction = "await-reply" | "listen" | "stop";

/** Pure state transition for the browser's turn-taking microphone loop. */
export function nextVoiceLoopAction(args: {
  outcome: VoiceCaptureOutcome;
  persistentLive: boolean;
  loopRequested: boolean;
}): VoiceLoopAction {
  if (!args.loopRequested) return "stop";
  // A true live session keeps capturing while Jarvis thinks and speaks. Echo
  // cancellation plus transcript echo guards distinguish his voice; Daniel's
  // own speech becomes a barge-in instead of waiting for the answer to finish.
  if (args.outcome === "speech") return args.persistentLive ? "listen" : "await-reply";
  if (
    args.persistentLive &&
    (args.outcome === "silence" || args.outcome === "empty" || args.outcome === "echo")
  ) {
    return "listen";
  }
  return "stop";
}
