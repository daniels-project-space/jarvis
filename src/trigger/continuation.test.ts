import { describe, expect, it } from "vitest";
import { buildContinuationCheckpoint, segmentTimeoutMs } from "./continuation";

describe("durable agent continuation", () => {
  it("preserves prior evidence, the latest narrative and recent execution trace", () => {
    const checkpoint = buildContinuationCheckpoint({
      attempt: 2,
      timedOut: true,
      priorCheckpoint: "Convex export scan completed and anonymous probes rejected.",
      narrative: "The state-machine attempt fence is sound; shared-vault inspection remains.",
      trace: "▸ inspected convex/jobs.ts\n▸ tested anonymous jobs:list\n▸ opened convex/vaultAuth.ts",
      deliveryNote: "read-only checkout; no branch delivery",
    });

    expect(checkpoint).toContain("Convex export scan completed");
    expect(checkpoint).toContain("state-machine attempt fence is sound");
    expect(checkpoint).toContain("opened convex/vaultAuth.ts");
    expect(checkpoint).toContain("do not restart broad discovery");
    expect(checkpoint.length).toBeLessThanOrEqual(6000);
  });

  it("keeps the newest trace evidence within the Convex checkpoint bound", () => {
    const trace = Array.from({ length: 180 }, (_, index) => `command-${index}: inspected boundary ${index}`).join("\n");
    const checkpoint = buildContinuationCheckpoint({
      attempt: 1,
      timedOut: true,
      priorCheckpoint: "prior ".repeat(1000),
      narrative: "narrative ".repeat(1000),
      trace,
      deliveryNote: "checkpoint branch retained ".repeat(100),
    });

    expect(checkpoint).toContain("command-179");
    expect(checkpoint).not.toContain("command-0:");
    expect(checkpoint).toContain("NEXT SEGMENT:");
    expect(checkpoint.length).toBeLessThanOrEqual(6000);
  });

  it("gives deep work more room without removing the segment boundary", () => {
    expect(segmentTimeoutMs("opus")).toBe(25 * 60_000);
    expect(segmentTimeoutMs("sonnet")).toBe(15 * 60_000);
    expect(segmentTimeoutMs("haiku")).toBe(15 * 60_000);
  });
});
