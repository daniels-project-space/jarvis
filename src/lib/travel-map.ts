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

export function googlePlacesTextQuery(request: TravelMapRequest): string {
  const subject = [request.preferences, request.query].filter(Boolean).join(" ");
  return request.location ? `${subject} in ${request.location}` : subject;
}

export function googlePlacesSearchBody(
  textQuery: string,
  options: { center?: TravelMapPoint; radiusMetres?: number; maxResults?: number } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    textQuery: boundedText(textQuery, 300),
    maxResultCount: Math.max(1, Math.min(20, Math.round(options.maxResults ?? 10))),
    languageCode: "en",
  };
  if (options.center && Number.isFinite(options.center.lat) && Number.isFinite(options.center.lng)) {
    body.locationBias = {
      circle: {
        center: { latitude: options.center.lat, longitude: options.center.lng },
        radius: Math.max(500, Math.min(50_000, Math.round(options.radiusMetres ?? 12_000))),
      },
    };
  }
  return body;
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

function coordinate(point: TravelMapPoint): string {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}

export function googleDirectionsUrl(options: {
  origin: TravelMapPoint | string;
  stops: Array<TravelMapPoint | string>;
  mode?: TravelMode;
}): string | undefined {
  if (!options.stops.length) return undefined;
  const value = (point: TravelMapPoint | string) => typeof point === "string" ? point : coordinate(point);
  const stops = options.stops.slice(0, 9);
  const destination = stops.at(-1)!;
  const params = new URLSearchParams({
    api: "1",
    origin: value(options.origin),
    destination: value(destination),
    travelmode: options.mode ?? "walking",
  });
  if (stops.length > 1) params.set("waypoints", stops.slice(0, -1).map(value).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
