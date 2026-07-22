export type ForegroundLane = "primary" | "handoff";

export function successorLane(owner: ForegroundLane): ForegroundLane {
  return owner === "primary" ? "handoff" : "primary";
}

export function taskForForegroundLane(lane: ForegroundLane): "jarvis-chat-turn" | "jarvis-chat-handoff" {
  return lane === "primary" ? "jarvis-chat-turn" : "jarvis-chat-handoff";
}
