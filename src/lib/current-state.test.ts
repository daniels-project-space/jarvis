import { describe, expect, it } from "vitest";
import { CURRENT_LOCATION_TTL_MS, extractCurrentStateFacts, shouldCaptureDurableMemory } from "./current-state";

describe("current state extraction", () => {
  it.each([
    ["I'm in Sevilla right now, can you show me a map with some attractions in the city?", "Sevilla"],
    ["I’m currently in sevilla.", "sevilla"],
    ["We are staying in São Paulo this week.", "São Paulo"],
    ["I am in London.", "London"],
  ])("extracts a high-confidence current location from %s", (text, place) => {
    expect(extractCurrentStateFacts(text)).toEqual([
      expect.objectContaining({ key: "profile.current_location", value: place, validForMs: CURRENT_LOCATION_TTL_MS }),
    ]);
  });

  it.each([
    "Where am I right now?",
    "I'm not in Sevilla.",
    "I'm no longer in London.",
    "I'm in a rush.",
    "He said I'm in Madrid.",
  ])("does not turn questions, negations, or idioms into state: %s", (text) => {
    expect(extractCurrentStateFacts(text)).toEqual([]);
  });
});

it("keeps conversational current-place context time-bounded", () => {
  expect(CURRENT_LOCATION_TTL_MS).toBe(12 * 60 * 60 * 1000);
});

describe("durable memory admission", () => {
  it("admits explicit durable facts but not ordinary work or location turns", () => {
    expect(shouldCaptureDurableMemory("Remember that I prefer aisle seats.")).toBe(true);
    expect(shouldCaptureDurableMemory("My birthday is 4 May.")).toBe(true);
    expect(shouldCaptureDurableMemory("Can you fix the map overlay?")).toBe(false);
    expect(shouldCaptureDurableMemory("I'm in Sevilla right now.")).toBe(false);
  });
});
