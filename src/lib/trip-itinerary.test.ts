import { describe, expect, it } from "vitest";
import { normalizeTripItinerary, stableTripItemId } from "./trip-itinerary";

describe("persisted trip itinerary normalization", () => {
  it("upgrades legacy tiles to stable, bounded records without trusting broken route geometry", () => {
    const itinerary = normalizeTripItinerary([
      {
        date: "2026-09-12",
        label: "Sat 12 Sep",
        items: [
          { time: "14:30", title: "Old Harbour", kind: "activity" },
          { time: "09:00", title: "Morning Market", kind: "activity" },
        ],
        route: {
          mode: "walking",
          status: "ready",
          coordinates: [[181, 90], [-9.14, 38.72]],
          durationSeconds: 400,
          distanceMeters: 500,
        },
      },
    ]);

    expect(itinerary).toHaveLength(1);
    expect(itinerary[0].items.map((item) => item.title)).toEqual(["Morning Market", "Old Harbour"]);
    expect(itinerary[0].items[0]).toMatchObject({
      id: stableTripItemId("2026-09-12", "activity", "Morning Market", 1),
      source: "generated",
    });
    // A route labelled ready without at least two safe coordinates becomes
    // stale rather than displaying a plausible but false line.
    expect(itinerary[0].route).toMatchObject({ status: "stale", coordinates: undefined });
  });

  it("drops malformed days and invalid times instead of making them actionable", () => {
    const itinerary = normalizeTripItinerary([
      { date: "not-a-date", items: [{ title: "ignore", kind: "activity" }] },
      { date: "2026-10-01", items: [{ title: "Safe place", kind: "activity", time: "27:99" }] },
    ]);

    expect(itinerary).toHaveLength(1);
    expect(itinerary[0].items[0].time).toBeUndefined();
  });
});
