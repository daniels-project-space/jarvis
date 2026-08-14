import { createRoot } from "react-dom/client";
import { useState } from "react";
import { TripLocationFollowControl } from "../../src/components/TripView";

type PositionListener = (position: GeolocationPosition) => void;

const listeners = new Map<number, PositionListener>();
let nextWatchId = 1;
let clearCalls = 0;
let commitActiveCity: ((cityContextId: string) => void) | undefined;

Object.defineProperty(navigator, "geolocation", {
  configurable: true,
  value: {
    watchPosition(success: PositionListener) {
      const watchId = nextWatchId++;
      listeners.set(watchId, success);
      return watchId;
    },
    clearWatch(watchId: number) {
      clearCalls += 1;
      listeners.delete(watchId);
    },
  },
});

declare global {
  interface Window {
    __tripLocationFixture?: {
      emit: (lat: number, lng: number, accuracyMeters?: number) => void;
      commitActiveCity: (cityContextId: string) => void;
      watchCount: () => number;
      clearCount: () => number;
    };
  }
}

window.__tripLocationFixture = {
  emit(lat, lng, accuracyMeters = 20) {
    const position = {
      coords: { latitude: lat, longitude: lng, accuracy: accuracyMeters },
    } as GeolocationPosition;
    for (const listener of listeners.values()) listener(position);
  },
  watchCount: () => nextWatchId - 1,
  clearCount: () => clearCalls,
  commitActiveCity: (cityContextId) => commitActiveCity?.(cityContextId),
};

const contexts = [
  { id: "seville", city: "Seville", center: { lat: 37.3891, lng: -5.9845 } },
  { id: "cordoba", city: "Córdoba", center: { lat: 37.8882, lng: -4.7794 } },
];

function LocationFollowFixture() {
  const [activeCity, setActiveCity] = useState("seville");
  const [selectionPayloads, setSelectionPayloads] = useState<Array<{ city_context_id: string }>>([]);
  commitActiveCity = setActiveCity;
  return (
    <main aria-label="Fixture trip location following">
      <h1>Trip location following</h1>
      <TripLocationFollowControl
        contexts={contexts}
        activeCityContextId={activeCity}
        onSelect={async (cityContextId) => {
          setSelectionPayloads((current) => [...current, { city_context_id: cityContextId }]);
          return true;
        }}
      />
      <output aria-label="Active fixture city">{activeCity}</output>
      <output aria-label="Selection payloads">{JSON.stringify(selectionPayloads)}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Trip location fixture root is missing.");

createRoot(root).render(<LocationFollowFixture />);
