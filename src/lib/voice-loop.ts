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
  // A transient MediaRecorder, network, or STT failure is not an instruction
  // to switch live mode off. Only Daniel (loopRequested=false) owns that
  // lifecycle decision; the caller may rebuild the device before retrying.
  if (args.persistentLive) return "listen";
  return "stop";
}

export function shouldMaintainLiveHeartbeat(args: {
  guest: boolean;
  visible: boolean;
  live: boolean;
}): boolean {
  return !args.guest && args.visible && args.live;
}
