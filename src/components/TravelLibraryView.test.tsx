import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { summarizeTravelCreation, TravelLibraryCards } from "./Views";

describe("saved travel library", () => {
  const plannedTrip = {
    _id: "trip-seville",
    title: "Seville city break",
    updatedAt: Date.UTC(2026, 7, 1),
    data: JSON.stringify({
      kind: "trip",
      title: "September in Seville",
      destination: "Seville",
      status: "planned",
      departDate: "2026-09-12",
      returnDate: "2026-09-15",
      budgetGbp: 1_850,
      mindmapCreationId: "canvas-seville",
      itinerary: [{
        date: "2026-09-12",
        items: [{ kind: "activity", title: "Alcázar" }, { kind: "activity", title: "Triana" }],
        route: { status: "ready", mode: "walking" },
      }],
    }),
  };

  it("derives only safe, useful trip-card facts from the durable creation", () => {
    expect(summarizeTravelCreation(plannedTrip)).toMatchObject({
      id: "trip-seville",
      destination: "Seville",
      status: "planned",
      budget: "£1,850",
      route: "1/1 day route ready",
      stops: 2,
      mindmapCreationId: "canvas-seville",
    });
  });

  it("renders a frosted saved-trip card with separate itinerary and mind-map entry points", () => {
    const html = renderToStaticMarkup(
      <TravelLibraryCards trips={[plannedTrip]} onOpenTrip={vi.fn()} onOpenMindmap={vi.fn()} />,
    );

    expect(html).toContain("Seville");
    expect(html).toContain("locked itinerary");
    expect(html).toContain("£1,850");
    expect(html).toContain("1/1 day route ready");
    expect(html).toContain("2 activity stops");
    expect(html).toContain("mind map");
    expect(html).toContain('aria-label="Open Seville travel workspace"');
    expect(html).toContain('aria-label="Open itinerary for Seville"');
  });

  it("keeps malformed historic records openable without rendering raw JSON", () => {
    const html = renderToStaticMarkup(
      <TravelLibraryCards
        trips={[{ _id: "legacy", title: "Lisbon notes", data: "{not json", updatedAt: Date.UTC(2026, 7, 1) }]}
        onOpenTrip={vi.fn()}
        onOpenMindmap={vi.fn()}
      />,
    );

    expect(html).toContain("Lisbon notes");
    expect(html).toContain("dates tbd");
    expect(html).toContain("budget tbd");
    expect(html).not.toContain("{not json");
  });
});
