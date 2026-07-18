import { describe, expect, it } from "vitest";
import { distillFinding } from "./finding-distill";

describe("deterministic finding distillation", () => {
  it("keeps customer and money findings visible with concrete detail", () => {
    const result = distillFinding({
      source: "Investigate the outstanding rental return",
      spoken: "One customer return is blocked and needs Daniel's decision.",
      detail: "- Booking 4821 is 3 days overdue.\n- Replacement value is £640.\n- Customer reply remains draft-only.",
    });
    expect(result.important).toBe(true);
    expect(result.bullets.join(" ")).toContain("£640");
    expect(result.bullets.length).toBeLessThanOrEqual(5);
  });

  it("keeps routine internal maintenance out of interruption cards", () => {
    const result = distillFinding({
      source: "SELF-REPAIR schema validator tooling fix",
      spoken: "The typecheck and test run passed.",
      detail: "Updated an internal validator and CI configuration.",
    });
    expect(result.important).toBe(false);
  });
});
