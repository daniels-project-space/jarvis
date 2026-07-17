export type WatchTransition = { trigger: boolean; conditionMet: boolean; reason: string };

export function evaluateWatchTransition(input: {
  kind: "asset" | "product" | string;
  definition: any;
  previousValue?: number;
  value: number;
  conditionMet: boolean;
  cooldownUntil?: number;
  lastNotifiedValue?: number;
  now: number;
}): WatchTransition {
  const { kind, definition, previousValue, value, cooldownUntil = 0, lastNotifiedValue, now } = input;
  let conditionMet = input.conditionMet;
  let trigger = false;
  let reason = "";
  if (kind === "asset") {
    const threshold = Number(definition.threshold);
    const rearm = Math.max(0, Number(definition.rearmBps ?? 10)) / 10_000;
    const meets = definition.operator === "above" ? value >= threshold : value <= threshold;
    const rearmed = definition.operator === "above" ? value < threshold * (1 - rearm) : value > threshold * (1 + rearm);
    if (previousValue === undefined) conditionMet = meets;
    else if (conditionMet && rearmed) conditionMet = false;
    if (previousValue !== undefined && !conditionMet && meets) {
      if (cooldownUntil <= now) {
        trigger = true;
        reason = `${definition.symbol} crossed ${definition.operator} ${definition.threshold}`;
      }
      conditionMet = true;
    }
  } else if (definition.targetPence) {
    const target = Number(definition.targetPence);
    const meets = value <= target;
    if (previousValue === undefined) conditionMet = meets;
    else if (conditionMet && value > target * 1.01) conditionMet = false;
    if (previousValue !== undefined && !conditionMet && meets) {
      if (cooldownUntil <= now) {
        trigger = true;
        reason = `Verified landed price fell below £${(target / 100).toFixed(2)}`;
      }
      conditionMet = true;
    }
  } else {
    const baseline = lastNotifiedValue ?? previousValue;
    const minimum = baseline === undefined
      ? Infinity
      : Math.max(Number(definition.minDropPence ?? 200), baseline * Number(definition.minDropBps ?? 300) / 10_000);
    if (baseline !== undefined && value <= baseline - minimum && cooldownUntil <= now) {
      trigger = true;
      reason = `Verified price improved by £${((baseline - value) / 100).toFixed(2)}`;
    }
  }
  return { trigger, conditionMet, reason };
}
