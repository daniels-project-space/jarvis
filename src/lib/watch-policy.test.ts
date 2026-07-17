import { describe, expect, it } from "vitest";
import { evaluateWatchTransition } from "../../convex/watchPolicy";

describe("watch crossing policy", () => {
  it("uses the first observation as a baseline without firing", () => {
    expect(evaluateWatchTransition({
      kind: "asset", definition: { symbol: "BTCUSDT", operator: "below", threshold: 60_000, rearmBps: 10 },
      value: 59_000, conditionMet: false, now: 1,
    })).toEqual({ trigger: false, conditionMet: true, reason: "" });
  });

  it("fires only on a false-to-true asset crossing and rearms with hysteresis", () => {
    const hit = evaluateWatchTransition({
      kind: "asset", definition: { symbol: "BTCUSDT", operator: "below", threshold: 60_000, rearmBps: 10 },
      previousValue: 61_000, value: 59_900, conditionMet: false, now: 1,
    });
    expect(hit.trigger).toBe(true);
    expect(evaluateWatchTransition({
      kind: "asset", definition: { symbol: "BTCUSDT", operator: "below", threshold: 60_000, rearmBps: 10 },
      previousValue: 59_900, value: 59_500, conditionMet: true, now: 2,
    }).trigger).toBe(false);
    expect(evaluateWatchTransition({
      kind: "asset", definition: { symbol: "BTCUSDT", operator: "below", threshold: 60_000, rearmBps: 10 },
      previousValue: 59_500, value: 60_100, conditionMet: true, now: 3,
    }).conditionMet).toBe(false);
  });

  it("does not defer a crossing into a false alert after cooldown", () => {
    const duringCooldown = evaluateWatchTransition({
      kind: "asset", definition: { symbol: "ETHUSDT", operator: "above", threshold: 4_000, rearmBps: 10 },
      previousValue: 3_900, value: 4_100, conditionMet: false, cooldownUntil: 10, now: 5,
    });
    expect(duringCooldown).toEqual({ trigger: false, conditionMet: true, reason: "" });
    expect(evaluateWatchTransition({
      kind: "asset", definition: { symbol: "ETHUSDT", operator: "above", threshold: 4_000, rearmBps: 10 },
      previousValue: 4_100, value: 4_200, conditionMet: true, cooldownUntil: 10, now: 11,
    }).trigger).toBe(false);
  });

  it("compares targetless product drops to the last notified baseline", () => {
    const common = { kind: "product", definition: { minDropBps: 300, minDropPence: 200 }, conditionMet: false, now: 10 };
    expect(evaluateWatchTransition({ ...common, previousValue: 9_900, lastNotifiedValue: 10_000, value: 9_800 }).trigger).toBe(false);
    expect(evaluateWatchTransition({ ...common, previousValue: 9_800, lastNotifiedValue: 10_000, value: 9_650 }).trigger).toBe(true);
  });
});
