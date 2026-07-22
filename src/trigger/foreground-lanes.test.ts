import { describe, expect, it } from "vitest";
import { successorLane, taskForForegroundLane, type ForegroundLane } from "./foreground-lanes";

describe("alternating foreground lanes", () => {
  it("alternates through three successive owners while prewarming the unoccupied lane", () => {
    const owners: ForegroundLane[] = ["primary"];
    const overlaps: Array<Set<ForegroundLane>> = [];
    for (let index = 0; index < 3; index += 1) {
      const owner = owners.at(-1)!;
      const successor = successorLane(owner);
      // Prewarm begins while the owner is still serving, but it is a distinct
      // lane and cannot become a second Convex owner until release.
      overlaps.push(new Set([owner, successor]));
      owners.push(successor);
    }
    expect(owners).toEqual(["primary", "handoff", "primary", "handoff"]);
    expect(overlaps.every((running) => running.size === 2)).toBe(true);
    expect(owners.slice(0, -1).map(taskForForegroundLane))
      .toEqual(["jarvis-chat-turn", "jarvis-chat-handoff", "jarvis-chat-turn"]);
  });
});
