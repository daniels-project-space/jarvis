import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({ api: {} }));
vi.mock("@/lib/secure-convex", () => ({ useJarvisQuery: () => null }));
vi.mock("@/lib/client-mutation", () => ({ clientMutation: vi.fn() }));
vi.mock("@/lib/viewer-request", () => ({ viewerFetch: vi.fn() }));

import { CalendarView } from "./Views";

describe("CalendarView source status", () => {
  it("shows a compact, honest connection warning when iCloud is unavailable", () => {
    const markup = renderToStaticMarkup(
      <CalendarView value={JSON.stringify({
        view: "day",
        label: "Monday 31 August",
        sources: { iCloud: "unavailable", rentals: "connected" },
        days: [{ date: "2026-08-31", dow: "Mon", inMonth: true, today: false, events: [], more: 0 }],
      })} />,
    );

    expect(markup).toContain("iCloud Calendar");
    expect(markup).toContain("will not call missing data a clear day");
    expect(markup).not.toContain("Clear day, sir");
  });
});
