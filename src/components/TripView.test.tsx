import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TripDayControls, TripTimeline } from "./TripView";

describe("TripTimeline", () => {
  it("renders persisted stop and transfer timing without drawing a made-up connection", () => {
    const markup = renderToStaticMarkup(
      <TripTimeline
        activeDate="2026-09-12"
        onSelectDay={vi.fn()}
        days={[
          {
            date: "2026-09-12",
            label: "Fri 12 Sep",
            items: [
              { id: "museum", time: "10:00", durationMinutes: 90, title: "City Museum", kind: "activity" },
              { id: "market", time: "12:00", durationMinutes: 45, title: "Riverside Market", kind: "activity", source: "saved" },
            ],
            route: {
              mode: "walking",
              status: "ready",
              coordinates: [[-0.12, 51.5], [-0.11, 51.51]],
              durationSeconds: 1_500,
              distanceMeters: 1_800,
              legs: [{ fromItemId: "museum", toItemId: "market", durationSeconds: 720, distanceMeters: 700 }],
              attribution: "OpenStreetMap / OSRM",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("City Museum");
    expect(markup).toContain("allow 1h 30m");
    expect(markup).toContain("walk · 12 min · 700 m");
    expect(markup).toContain("25 min");
    expect(markup).toContain("1.8 km");
    expect(markup).toContain("OpenStreetMap / OSRM");
  });

  it("shows an unavailable route honestly and omits transfer timing that was never returned", () => {
    const markup = renderToStaticMarkup(
      <TripTimeline
        activeDate="2026-09-12"
        onSelectDay={vi.fn()}
        days={[
          {
            date: "2026-09-12",
            label: "Fri 12 Sep",
            items: [{ id: "park", title: "Hill Park", kind: "activity" }],
            route: { mode: "walking", status: "unavailable" },
          },
        ]}
      />,
    );

    expect(markup).toContain("route unavailable");
    expect(markup).toContain("Hill Park");
    expect(markup).toContain("time tbd");
    expect(markup).not.toContain("↓");
    expect(markup).not.toContain("allow ");
  });

  it("offers date, time, order, transport, and explicit lock controls without calendar mutation UI", () => {
    const markup = renderToStaticMarkup(
      <TripDayControls
        busy={false}
        day={{
          date: "2026-09-12",
          label: "Fri 12 Sep",
          items: [{ id: "museum", placeId: "City Museum", time: "10:00", title: "City Museum", kind: "activity" }],
          route: { mode: "walking", status: "ready" },
        }}
        availableActivities={[{ name: "City Museum" }, { name: "Riverside Market" }]}
        onLock={vi.fn()}
        onSave={vi.fn()}
        onSelectDay={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Plan date"');
    expect(markup).toContain('aria-label="Time for City Museum"');
    expect(markup).toContain('aria-label="Transport mode"');
    expect(markup).toContain("save route &amp; times");
    expect(markup).toContain("lock day");
    expect(markup).toContain("Calendar remains separate and requires protected approval.");
  });
});
