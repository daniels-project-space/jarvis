export type FollowableTripCityContext = {
  id: string;
  center: { lat: number; lng: number };
};

export type LocalTripPosition = {
  lat: number;
  lng: number;
  /** The browser's estimated horizontal accuracy. It never leaves the device. */
  accuracyMeters?: number;
};

export const TRIP_LOCATION_MAX_ACCURACY_METERS = 10_000;
export const TRIP_LOCATION_ACQUIRE_KM = 35;
export const TRIP_LOCATION_RETAIN_KM = 50;
export const TRIP_LOCATION_SWITCH_MARGIN_KM = 5;

const validLatLng = (lat: unknown, lng: unknown) =>
  typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90
  && typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;

const radians = (degrees: number) => degrees * Math.PI / 180;

export function tripLocationDistanceKm(
  from: Pick<LocalTripPosition, "lat" | "lng">,
  to: { lat: number; lng: number },
): number {
  const latitudeDelta = radians(to.lat - from.lat);
  const longitudeDelta = radians(to.lng - from.lng);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Selects a saved city from a browser-only position. It deliberately cannot
 * create a city, reverse-geocode, or emit coordinates: location is used only
 * to keep a pre-existing trip context stable as someone moves between places.
 */
export function followTripCityContext(input: {
  contexts: FollowableTripCityContext[];
  currentContextId?: string;
  position: LocalTripPosition;
  maxAccuracyMeters?: number;
  acquireKm?: number;
  retainKm?: number;
  switchMarginKm?: number;
}): FollowableTripCityContext | null {
  const maxAccuracyMeters = input.maxAccuracyMeters ?? TRIP_LOCATION_MAX_ACCURACY_METERS;
  const acquireKm = input.acquireKm ?? TRIP_LOCATION_ACQUIRE_KM;
  const retainKm = input.retainKm ?? TRIP_LOCATION_RETAIN_KM;
  const switchMarginKm = input.switchMarginKm ?? TRIP_LOCATION_SWITCH_MARGIN_KM;
  if (!validLatLng(input.position.lat, input.position.lng)
    || (typeof input.position.accuracyMeters === "number"
      && (!Number.isFinite(input.position.accuracyMeters) || input.position.accuracyMeters > maxAccuracyMeters))) {
    return null;
  }

  const candidates = input.contexts
    .filter((context) => Boolean(context?.id) && validLatLng(context.center?.lat, context.center?.lng))
    .map((context) => ({ context, distanceKm: tripLocationDistanceKm(input.position, context.center) }))
    .sort((left, right) => left.distanceKm - right.distanceKm);
  const closest = candidates[0];
  if (!closest) return null;

  const current = candidates.find((candidate) => candidate.context.id === input.currentContextId);
  if (current && current.context.id !== closest.context.id
    && current.distanceKm <= retainKm
    && closest.distanceKm + switchMarginKm >= current.distanceKm) {
    return current.context;
  }
  if (closest.distanceKm <= acquireKm) return closest.context;
  return current && current.distanceKm <= retainKm ? current.context : null;
}
