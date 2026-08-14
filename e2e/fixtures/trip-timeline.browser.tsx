import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ComponentProps } from "react";
import { TripDayControls, TripTimeline } from "../../src/components/TripView";
import "./trip-timeline.fixture.css";

type TimelineDays = ComponentProps<typeof TripTimeline>["days"];
type SavePayload = Parameters<ComponentProps<typeof TripDayControls>["onSave"]>[0];

// This is deliberately synthetic, stable fixture data. The harness never reads
// a saved trip, user location, booking, or connected provider.
const fixtureDays: TimelineDays = [
  {
    date: "2026-09-12",
    label: "Fri 12 Sep",
    status: "scheduled",
    items: [
      {
        id: "city-museum",
        time: "10:00",
        durationMinutes: 90,
        title: "City Museum",
        kind: "activity",
        source: "fixture",
      },
      {
        id: "riverside-market",
        time: "12:00",
        durationMinutes: 45,
        title: "Riverside Market",
        kind: "activity",
        source: "fixture",
      },
    ],
    route: {
      mode: "walking",
      status: "ready",
      coordinates: [
        [-0.12, 51.5],
        [-0.11, 51.51],
      ],
      durationSeconds: 1_500,
      distanceMeters: 1_800,
      legs: [
        {
          fromItemId: "city-museum",
          toItemId: "riverside-market",
          durationSeconds: 720,
          distanceMeters: 700,
        },
      ],
      attribution: "OpenStreetMap / OSRM",
    },
  },
  {
    date: "2026-09-13",
    label: "Sat 13 Sep",
    status: "needs routing",
    items: [
      {
        id: "hill-park",
        title: "Hill Park",
        kind: "activity",
        source: "fixture",
      },
    ],
    route: {
      mode: "walking",
      status: "unavailable",
    },
  },
];

const fixtureActivities = [
  { name: "City Museum" },
  { name: "Riverside Market" },
  { name: "Canal Gallery" },
];

function TripTimelineFixture() {
  const [activeDate, setActiveDate] = useState(fixtureDays[0]?.date ?? null);
  const [lockedDates, setLockedDates] = useState<Record<string, boolean>>({});
  const [lastSave, setLastSave] = useState<SavePayload | null>(null);
  const [lastLock, setLastLock] = useState<boolean | null>(null);
  const initialDay = fixtureDays[0];
  if (!initialDay) throw new Error("Trip timeline fixture needs at least one day.");
  const baseDay = fixtureDays.find((day) => day.date === activeDate) ?? initialDay;
  const activeDay = lockedDates[baseDay.date] ? { ...baseDay, status: "locked" } : baseDay;

  const saveDay = (payload: SavePayload) => {
    setLastSave(payload);
  };

  const lockDay = (locked: boolean) => {
    setLockedDates((current) => ({ ...current, [activeDay.date]: locked }));
    setLastLock(locked);
  };

  return (
    <main className="fixture-shell" aria-label="Fixture trip itinerary">
      <div className="fixture-backdrop" aria-hidden />
      <section className="fixture-card" aria-label="Fixture-only browser validation">
        <p className="fixture-eyebrow">Local fixture · no connected data</p>
        <h1>Trip itinerary timeline</h1>
        <p className="fixture-copy">
          Deterministic route and unavailable-route states for browser validation only.
        </p>
        <TripTimeline days={fixtureDays} activeDate={activeDate} onSelectDay={setActiveDate} />
        <div className="fixture-controls">
          <h2>Fixture edit controls</h2>
          <p>
            Save and lock callbacks are captured below as synthetic state only; this harness never persists a plan.
          </p>
          <TripDayControls
            availableActivities={fixtureActivities}
            busy={false}
            day={activeDay}
            onLock={lockDay}
            onSave={saveDay}
            onSelectDay={setActiveDate}
          />
          <div className="fixture-payloads" aria-label="Synthetic callback results">
            <div>
              <span>last save payload</span>
              <output aria-label="Last synthetic save payload">{lastSave ? JSON.stringify(lastSave) : "not saved"}</output>
            </div>
            <div>
              <span>last lock payload</span>
              <output aria-label="Last synthetic lock payload">{lastLock === null ? "not invoked" : String(lastLock)}</output>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Trip timeline fixture root is missing.");

createRoot(root).render(<TripTimelineFixture />);
