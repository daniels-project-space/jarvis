import { describe, expect, it } from "vitest";
import { memoryConfidence, memoryDedupeKey } from "./memory-governance";

describe("memory governance", () => {
  it("creates a stable non-content identifier for a canonical claim", () => {
    expect(memoryDedupeKey("preference", "Daniel prefers concise, evidence-backed updates"))
      .toBe("v1:preference:daniel-prefers-concise-evidence-backed-updates");
    expect(memoryDedupeKey("invalid kind", "Still valid title")).toBeNull();
  });

  it("bounds confidence without inventing precision", () => {
    expect(memoryConfidence(1.4)).toBe(1);
    expect(memoryConfidence(-0.2)).toBe(0);
    expect(memoryConfidence("unknown", 0.65)).toBe(0.65);
  });
});
