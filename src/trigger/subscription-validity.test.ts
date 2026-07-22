import { describe, expect, it } from "vitest";
import {
  CODEX_CONSUMER_FINALIZATION_RESERVE_MS,
  CODEX_CONSUMER_STARTUP_RESERVE_MS,
  DEFAULT_SUBSCRIPTION_VALIDITY_MS,
  MAX_BACKGROUND_CODEX_SEGMENT_MS,
  MEMORY_CODEX_EXECUTION_RESERVE_MS,
  MEMORY_SUBSCRIPTION_VALIDITY_MS,
  PINNED_CODEX_INTERNAL_REFRESH_GUARD_MS,
  backgroundSubscriptionValidityMs,
} from "./subscription-validity";

describe("Codex subscription validity windows", () => {
  it("keeps both 15-minute and 25-minute workers outside the pinned refresh boundary", () => {
    for (const segmentMs of [15 * 60_000, 25 * 60_000]) {
      const validity = backgroundSubscriptionValidityMs(segmentMs);
      expect(validity - CODEX_CONSUMER_STARTUP_RESERVE_MS - segmentMs
        - CODEX_CONSUMER_FINALIZATION_RESERVE_MS).toBe(PINNED_CODEX_INTERNAL_REFRESH_GUARD_MS);
      expect(validity).toBeGreaterThan(segmentMs + PINNED_CODEX_INTERNAL_REFRESH_GUARD_MS);
    }
    expect(DEFAULT_SUBSCRIPTION_VALIDITY_MS).toBe(
      backgroundSubscriptionValidityMs(MAX_BACKGROUND_CODEX_SEGMENT_MS),
    );
  });

  it("covers the complete 90-second memory process plus startup, finalization, and guard", () => {
    expect(MEMORY_SUBSCRIPTION_VALIDITY_MS).toBe(
      CODEX_CONSUMER_STARTUP_RESERVE_MS
      + MEMORY_CODEX_EXECUTION_RESERVE_MS
      + CODEX_CONSUMER_FINALIZATION_RESERVE_MS
      + PINNED_CODEX_INTERNAL_REFRESH_GUARD_MS,
    );
  });
});
