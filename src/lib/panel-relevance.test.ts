import { describe, expect, it } from "vitest";
import { isPanelFollowUp } from "./panel-relevance";

describe("isPanelFollowUp", () => {
  it("keeps explicit ranking and short deictic follow-ups", () => {
    expect(isPanelFollowUp("Tell me more about number 3", { title: "Top earners" })).toBe(true);
    expect(isPanelFollowUp("Show me the next item", { title: "Top earners" })).toBe(true);
    expect(isPanelFollowUp("Why is it down today?", { title: "BTC · 1d" })).toBe(true);
    expect(isPanelFollowUp("And what about that one?", { title: "Camera shortlist" })).toBe(true);
  });

  it("keeps a turn that names the panel subject", () => {
    expect(isPanelFollowUp("Show me Bitcoin on the weekly timeframe", { title: "Bitcoin chart" })).toBe(true);
  });

  it("dismisses long topic switches containing generic pronouns", () => {
    expect(
      isPanelFollowUp(
        "The live ticker turns off after a response and I want it to stay on so we can have a continuous conversation.",
        { title: "Bitcoin chart" },
      ),
    ).toBe(false);
  });

  it("treats a stale-panel complaint as a dismissal", () => {
    expect(
      isPanelFollowUp("While we're talking, the Bitcoin chart is still open.", { title: "Bitcoin chart" }),
    ).toBe(false);
  });

  it("dismisses an unrelated short request", () => {
    expect(isPanelFollowUp("What's next on the agenda?", { title: "BTC · 1d" })).toBe(false);
  });
});
