import { describe, expect, it } from "vitest";
import {
  LOCAL_HANDOVER_USED_PERCENT_THRESHOLD,
  inspectCodexWeeklyQuota,
  localCodingRuntime,
} from "./local-handover-protocol";

describe("local VPS handover quota protocol", () => {
  it("uses only documented weekly Codex buckets and reports the limiting remaining percentage", () => {
    const status = inspectCodexWeeklyQuota({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 96, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        },
        codex_other: {
          limitId: "codex_other",
          primary: { usedPercent: 98, windowDurationMins: 10_080, resetsAt: 1_800_010_000 },
        },
      },
    });

    expect(status).toMatchObject({
      state: "available",
      remainingPercent: 2,
      resetsAt: 1_800_010_000,
    });
    expect(status.buckets).toHaveLength(2);
  });

  it("requests the one-percent handover as soon as any weekly bucket reaches 99% used", () => {
    const status = inspectCodexWeeklyQuota({
      rateLimitsByLimitId: {
        codex: {
          primary: {
            usedPercent: LOCAL_HANDOVER_USED_PERCENT_THRESHOLD,
            windowDurationMins: 10_080,
            resetsAt: 1_800_000_000,
          },
        },
      },
    });

    expect(status.state).toBe("threshold");
    expect(status.remainingPercent).toBe(1);
  });

  it("fails closed for hourly, malformed, or absent quotas", () => {
    expect(inspectCodexWeeklyQuota({
      rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } },
    })).toEqual({ state: "unavailable", buckets: [] });
    expect(inspectCodexWeeklyQuota({ rateLimits: { primary: { usedPercent: 99 } } })).toEqual({
      state: "unavailable",
      buckets: [],
    });
    expect(inspectCodexWeeklyQuota({
      rateLimits: { primary: { usedPercent: 100, windowDurationMins: 43_200 } },
    })).toEqual({ state: "unavailable", buckets: [] });
  });

  it("keeps the provider-to-local-runtime mapping explicit", () => {
    expect(localCodingRuntime("codex")).toBe("vps_codex");
    expect(localCodingRuntime("claude")).toBe("vps_claude");
  });
});
