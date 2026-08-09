import { describe, expect, it } from "vitest";
import { planVoiceDelivery, voiceDeliveryCacheKey } from "./voice-delivery";

describe("voice delivery conductor", () => {
  it("keeps short acknowledgements brisk without changing their words", () => {
    expect(planVoiceDelivery("On it — I found the key source.")).toEqual({
      rate: 1.1,
      pitchHz: 4,
      cadence: "brief",
    });
  });

  it("slows dense or consequential answers for clarity", () => {
    const plan = planVoiceDelivery("Important: the financial decision is not confirmed; check the 2026 figures first.");
    expect(plan).toEqual({ rate: 0.99, pitchHz: 2, cadence: "careful" });
    expect(voiceDeliveryCacheKey(plan)).toBe("0.99:2:careful");
  });
});
