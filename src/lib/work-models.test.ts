import { describe, expect, it } from "vitest";
import {
  normalizeWorkModelTier,
  parseWorkModelTier,
  workModelLabel,
  workModelPriority,
} from "./work-models";

describe("Codex work model labels", () => {
  it("uses Luna, Terra and Sol as the durable public tiers", () => {
    expect(parseWorkModelTier("luna")).toBe("luna");
    expect(workModelLabel("terra")).toBe("Terra");
    expect(workModelPriority("sol")).toBe(80);
  });

  it("normalizes unfinished pre-migration jobs without exposing old labels", () => {
    expect(normalizeWorkModelTier("haiku")).toBe("luna");
    expect(normalizeWorkModelTier("sonnet")).toBe("terra");
    expect(normalizeWorkModelTier("opus")).toBe("sol");
  });

  it("falls back unknown input to balanced Terra intelligence", () => {
    expect(parseWorkModelTier("unknown")).toBeNull();
    expect(normalizeWorkModelTier("unknown")).toBe("terra");
  });
});
