import { createRoot } from "react-dom/client";
import { TripOfflineMapPreflight } from "../../src/components/TripView";

function AppleMapsOfflineFixture() {
  return (
    <main aria-label="Apple Maps offline preflight fixture">
      <h1>Apple Maps offline preflight</h1>
      <TripOfflineMapPreflight preflight={{
        city: "Seville",
        at: Date.parse("2030-09-02T09:15:00+02:00"),
        timeZone: "Europe/Madrid",
        mapUrl: "https://maps.apple.com/search?query=Seville",
        todoStatus: "existing",
        reminderStatus: "scheduled",
        calendarStatus: "needs_connection",
      }} />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Apple Maps offline fixture root is missing.");
createRoot(root).render(<AppleMapsOfflineFixture />);
