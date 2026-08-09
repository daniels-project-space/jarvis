export type TravelMode = "walking" | "driving" | "transit" | "bicycling";

export type TravelMapRequest = {
  location?: string;
  query: string;
  preferences?: string;
  includeBookings: boolean;
  route: boolean;
  travelMode: TravelMode;
};

export type TravelMapPoint = {
  lat: number;
  lng: number;
};

function boundedText(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function normalizeTravelMapRequest(args: Record<string, unknown>): TravelMapRequest {
  const location = boundedText(args.location ?? args.city, 120) || undefined;
  const query = boundedText(args.query, 180) || "interesting places and attractions";
  const preferences = boundedText(args.preferences ?? args.vibe, 220) || undefined;
  const requestedMode = boundedText(args.travel_mode ?? args.mode, 20);
  const travelMode: TravelMode = ["walking", "driving", "transit", "bicycling"].includes(requestedMode)
    ? requestedMode as TravelMode
    : "walking";
  const route = args.route === true || args.plan_route === true;
  return {
    location,
    query,
    preferences,
    // Booking lookup stays opt-in for a simple map, but route/itinerary requests
    // use the connected booking as a base unless the caller explicitly declines.
    includeBookings: args.include_bookings === true || (route && args.include_bookings !== false),
    route,
    travelMode,
  };
}

export function placeSearchTextQuery(request: TravelMapRequest): string {
  const subject = [request.preferences, request.query].filter(Boolean).join(" ");
  return request.location ? `${subject} in ${request.location}` : subject;
}

function distanceSquared(left: TravelMapPoint, right: TravelMapPoint): number {
  const latitudeScale = Math.cos(((left.lat + right.lat) / 2) * Math.PI / 180);
  const lat = left.lat - right.lat;
  const lng = (left.lng - right.lng) * latitudeScale;
  return lat * lat + lng * lng;
}

/** Deterministic nearest-neighbour ordering for a suggested itinerary. */
export function orderTravelMapPoints<T extends TravelMapPoint>(origin: TravelMapPoint, points: T[]): T[] {
  const remaining = points.map((point, index) => ({ point, index }));
  const ordered: T[] = [];
  let cursor = origin;
  while (remaining.length) {
    remaining.sort((left, right) => {
      const distance = distanceSquared(cursor, left.point) - distanceSquared(cursor, right.point);
      return distance || left.index - right.index;
    });
    const next = remaining.shift()!;
    ordered.push(next.point);
    cursor = next.point;
  }
  return ordered;
}
