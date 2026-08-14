import { describe, expect, it } from "vitest";
import {
  CURRENT_LOCATION_MAX_AGE_MS,
  LIVE_DEVICE_LOCATION_MAX_AGE_MS,
  LIVE_LOCATION_HEARTBEAT_MS,
  LIVE_LOCATION_MIN_MOVE_METRES,
  LIVE_LOCATION_MIN_REPORT_INTERVAL_MS,
  deviceLocationFreshness,
  freshCurrentLocation,
  freshDeviceLocation,
  shouldPersistLiveLocation,
} from "./live-location";

describe("live location freshness", () => {
  const now = Date.UTC(2026, 7, 13, 12, 0, 0);

  it("accepts only recent, bounded device coordinates", () => {
    expect(freshDeviceLocation({ value: "51.5074,-0.1278", updatedAt: now - LIVE_DEVICE_LOCATION_MAX_AGE_MS + 1 }, now))
      .toMatchObject({ lat: 51.5074, lng: -0.1278 });
    expect(deviceLocationFreshness({ value: "51.5074,-0.1278", updatedAt: now - LIVE_DEVICE_LOCATION_MAX_AGE_MS - 1 }, now)).toBe("stale");
    expect(deviceLocationFreshness({ value: "91,0", updatedAt: now }, now)).toBe("invalid");
    expect(freshDeviceLocation({ value: "51.5074,-0.1278", updatedAt: now - LIVE_DEVICE_LOCATION_MAX_AGE_MS - 1 }, now)).toBeUndefined();
  });

  it("expires conversational current-place assertions independently", () => {
    expect(freshCurrentLocation({ value: "Sevilla", observedAt: now - CURRENT_LOCATION_MAX_AGE_MS + 1 }, now))
      .toEqual({ value: "Sevilla", observedAt: now - CURRENT_LOCATION_MAX_AGE_MS + 1 });
    expect(freshCurrentLocation({ value: "Sevilla", observedAt: now - CURRENT_LOCATION_MAX_AGE_MS - 1 }, now)).toBeUndefined();
  });
});

describe("live location reporting", () => {
  const startedAt = Date.UTC(2026, 7, 13, 12, 0, 0);
  const previous = { lat: 51.5074, lng: -0.1278, sentAt: startedAt };

  it("persists a first sample, meaningful movement, and a stationary heartbeat", () => {
    expect(shouldPersistLiveLocation(undefined, { lat: 51.5074, lng: -0.1278, capturedAt: startedAt })).toBe(true);
    expect(shouldPersistLiveLocation(previous, {
      lat: 51.508, lng: -0.1278,
      capturedAt: startedAt + LIVE_LOCATION_MIN_REPORT_INTERVAL_MS - 1,
    })).toBe(false);
    expect(shouldPersistLiveLocation(previous, {
      lat: 51.5074 + LIVE_LOCATION_MIN_MOVE_METRES / 90_000,
      lng: -0.1278,
      capturedAt: startedAt + LIVE_LOCATION_MIN_REPORT_INTERVAL_MS,
    })).toBe(true);
    expect(shouldPersistLiveLocation(previous, {
      lat: previous.lat, lng: previous.lng,
      capturedAt: startedAt + LIVE_LOCATION_HEARTBEAT_MS,
    })).toBe(true);
  });
});
