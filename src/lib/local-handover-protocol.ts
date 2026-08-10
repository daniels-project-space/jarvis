/**
 * Provider-neutral facts shared by the VPS handover supervisor and the web
 * control plane. This deliberately contains no credentials, provider session
 * data, or process-control code.
 */

export const LOCAL_HANDOVER_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
export const LOCAL_HANDOVER_REMAINING_PERCENT = 1;
export const LOCAL_HANDOVER_USED_PERCENT_THRESHOLD = 100 - LOCAL_HANDOVER_REMAINING_PERCENT;

export type LocalCodingProvider = "codex" | "claude";

export type CodexWeeklyQuotaBucket = Readonly<{
  limitId: string;
  window: "primary" | "secondary";
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: number;
}>;

export type CodexWeeklyQuotaStatus = Readonly<{
  state: "available" | "threshold" | "unavailable";
  remainingPercent?: number;
  resetsAt?: number;
  buckets: readonly CodexWeeklyQuotaBucket[];
}>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function percentage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Converts the documented `account/rateLimits/read` payload into the only
 * automatic-switch signal we accept. A missing/malformed weekly bucket fails
 * closed: the supervisor must not pretend an hourly or unknown limit is a
 * weekly subscription limit.
 */
export function inspectCodexWeeklyQuota(value: unknown): CodexWeeklyQuotaStatus {
  const root = record(value);
  if (!root) return { state: "unavailable", buckets: [] };

  const sources: Array<[string, unknown]> = [];
  const byLimitId = record(root.rateLimitsByLimitId);
  if (byLimitId) sources.push(...Object.entries(byLimitId));
  if (root.rateLimits !== undefined) sources.push(["default", root.rateLimits]);

  const buckets: CodexWeeklyQuotaBucket[] = [];
  const seen = new Set<string>();
  for (const [fallbackLimitId, candidate] of sources) {
    const limit = record(candidate);
    if (!limit) continue;
    const limitId = typeof limit.limitId === "string" && limit.limitId.trim()
      ? limit.limitId.trim()
      : fallbackLimitId;
    for (const window of ["primary", "secondary"] as const) {
      const quota = record(limit[window]);
      if (!quota) continue;
      const usedPercent = percentage(quota.usedPercent);
      const windowDurationMins = positiveInteger(quota.windowDurationMins);
      // This policy is specifically the weekly subscription threshold. Do not
      // treat a longer monthly/rolling bucket as a weekly signal: a missing
      // exact weekly bucket must fail closed instead.
      if (usedPercent === null || windowDurationMins !== LOCAL_HANDOVER_WEEKLY_WINDOW_MINUTES) continue;
      const key = `${limitId}:${window}:${windowDurationMins}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.push({
        limitId,
        window,
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        resetsAt: positiveInteger(quota.resetsAt),
      });
    }
  }

  if (!buckets.length) return { state: "unavailable", buckets: [] };
  const limitingBucket = [...buckets].sort((left, right) =>
    left.remainingPercent - right.remainingPercent
    || (left.resetsAt ?? Number.MAX_SAFE_INTEGER) - (right.resetsAt ?? Number.MAX_SAFE_INTEGER))[0];
  return {
    state: limitingBucket.usedPercent >= LOCAL_HANDOVER_USED_PERCENT_THRESHOLD ? "threshold" : "available",
    remainingPercent: limitingBucket.remainingPercent,
    resetsAt: limitingBucket.resetsAt,
    buckets,
  };
}

export function isLocalCodingProvider(value: unknown): value is LocalCodingProvider {
  return value === "codex" || value === "claude";
}

export function localCodingRuntime(provider: LocalCodingProvider): "vps_codex" | "vps_claude" {
  return provider === "claude" ? "vps_claude" : "vps_codex";
}
