import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { bookedStayMapMarker, mergeTripMapMarker, type TripMapMarker } from "../../src/components/TripView";

// This uses the production marker admission helper, but intentionally does
// not load MapLibre or any connected data. It gives the browser test a stable
// visual surface for the privacy-critical city scoping rule.
const now = Date.UTC(2026, 8, 12, 12, 0);
const contexts = [
  {
    id: "amsterdam",
    city: "Amsterdam",
    bookingReference: {
      cityContextId: "amsterdam",
      city: "Amsterdam",
      bookingName: "Canal House",
      location: "42 Water Street, Amsterdam",
      start: now - 3_600_000,
      end: now + 86_400_000,
      lat: 52.369,
      lng: 4.9,
      verifiedAt: now - 60_000,
    },
  },
  {
    id: "berlin",
    city: "Berlin",
    bookingReference: {
      cityContextId: "berlin",
      city: "Berlin",
      bookingName: "Museum Quarter Stay",
      location: "8 Museum Lane, Berlin",
      start: now - 3_600_000,
      end: now + 86_400_000,
      lat: 52.52,
      lng: 13.405,
      verifiedAt: now - 60_000,
    },
  },
] as const;

function BookedStayMarkerFixture() {
  const [activeCityId, setActiveCityId] = useState("amsterdam");
  const activeCity = contexts.find((context) => context.id === activeCityId) ?? contexts[0];
  const markers = useMemo(() => {
    // This represents a hotel-search result that resolves to the exact same
    // place as the Gmail-confirmed booking. The booked pin must remain visible
    // rather than being deduplicated away as an ordinary stay marker.
    let visible: TripMapMarker[] = [{
      key: `stay:suggested-${activeCity.id}`,
      lat: activeCity.bookingReference.lat,
      lng: activeCity.bookingReference.lng,
      kind: "stay",
      name: `Suggested stay · ${activeCity.city}`,
    }];
    for (const context of contexts) {
      const marker = bookedStayMapMarker(context.bookingReference, activeCity, now);
      if (marker) visible = mergeTripMapMarker(visible, marker);
    }
    return visible;
  }, [activeCity]);

  return (
    <main aria-label="Fixture booked location map marker" style={{ background: "#071017", color: "#edf9ff", fontFamily: "system-ui", minHeight: "100vh", padding: 28 }}>
      <section style={{ maxWidth: 520, border: "1px solid rgba(140,236,255,.25)", borderRadius: 18, background: "rgba(255,255,255,.055)", boxShadow: "0 18px 60px rgba(0,0,0,.35)", padding: 20 }}>
        <p style={{ color: "#8cecff", fontSize: 11, letterSpacing: ".1em", margin: 0, textTransform: "uppercase" }}>Local fixture · production marker helper</p>
        <h1 style={{ margin: "8px 0 16px" }}>Booked location on the active city map</h1>
        <label style={{ display: "grid", gap: 6, maxWidth: 230 }}>
          <span style={{ color: "#a9bdc9", fontSize: 12 }}>Active city</span>
          <select aria-label="Active fixture city" value={activeCity.id} onChange={(event) => setActiveCityId(event.target.value)}>
            {contexts.map((context) => <option key={context.id} value={context.id}>{context.city}</option>)}
          </select>
        </label>
        <section aria-label="Map markers" style={{ background: "radial-gradient(circle at 30% 25%, #164152, #071017 68%)", borderRadius: 14, marginTop: 20, minHeight: 220, padding: 18 }}>
          {markers.map((marker) => (
            <div key={marker.key} aria-label={`Map marker: ${marker.name}`} style={{ alignItems: "center", background: "rgba(0,255,136,.12)", border: "1px solid rgba(0,255,136,.5)", borderRadius: 10, color: "#baffdc", display: "inline-flex", gap: 8, padding: "9px 11px" }}>
              <span aria-hidden style={{ color: "#00ff88", fontSize: 18 }}>●</span>
              <span>
                <strong>{marker.name}</strong>
                <span style={{ color: "#a9bdc9", display: "block", fontSize: 12 }}>{activeCity.bookingReference.bookingName}</span>
              </span>
            </div>
          ))}
        </section>
        <output aria-label="Visible marker count" style={{ color: "#a9bdc9", display: "block", fontSize: 12, marginTop: 12 }}>{markers.length} visible city-scoped marker{markers.length === 1 ? "" : "s"}</output>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Booked-stay marker fixture root is missing.");

createRoot(root).render(<BookedStayMarkerFixture />);
