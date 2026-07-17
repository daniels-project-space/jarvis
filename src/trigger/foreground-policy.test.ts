import { describe, expect, it } from "vitest";
import {
  FOREGROUND_CONCURRENCY,
  FOREGROUND_MAX_DURATION_SECONDS,
  FOREGROUND_QUEUE,
  FOREGROUND_TURN_TIMEOUT_MS,
} from "./foreground-policy";

describe("foreground conversation policy", () => {
  it("reserves parallel short-lived capacity for Jarvis conversation", () => {
    expect(FOREGROUND_QUEUE).toBe("jarvis-foreground");
    expect(FOREGROUND_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(FOREGROUND_TURN_TIMEOUT_MS).toBeLessThanOrEqual(3 * 60_000);
    expect(FOREGROUND_MAX_DURATION_SECONDS).toBeLessThanOrEqual(5 * 60);
  });
});
