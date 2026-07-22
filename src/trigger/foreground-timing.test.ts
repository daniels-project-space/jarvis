import { describe, expect, it } from "vitest";
import { buildForegroundTiming, type ForegroundTurnTiming } from "./foreground-timing";

describe("foreground timing metadata", () => {
  it("returns a bounded structured object containing only timing metadata", () => {
    const turns: ForegroundTurnTiming[] = Array.from({ length: 13 }, (_, index) => ({
      claimMs: index,
      contextMs: index + 1,
      completionMs: index + 2,
      finalizeMs: index + 3,
      deliveredMs: index + 4,
    }));

    const timing = buildForegroundTiming(turns, 42_000, "handoff");

    expect(timing).toBeTypeOf("object");
    expect(timing).not.toBeTypeOf("string");
    expect(Object.keys(timing).sort()).toEqual(["lane", "runnerAgeMs", "turns"]);
    expect(timing).toMatchObject({ runnerAgeMs: 42_000, lane: "handoff" });
    expect(timing.turns).toHaveLength(12);
    expect(timing.turns.map((turn) => turn.claimMs)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });
});
