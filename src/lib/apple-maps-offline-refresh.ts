import "server-only";
import { createHash } from "node:crypto";
import type { ConfirmedBooking } from "./booking-email";

export type AppleMapsOfflineGmailIdentity = {
  /** Opaque selection returned by the original Gmail flight picker. */
  selectionId: string;
  messageId: string;
  marker: string;
  threadId?: string;
  kind: string;
  provider: string;
  confirmationCode?: string;
};

export type AppleMapsOfflineCityProof = {
  city: string;
  title: string;
  bookingName?: string;
  location: string;
  start: number;
  end: number;
  timeZone?: string;
  lat: number;
  lng: number;
  distanceKm: number;
  verifiedAt: number;
};

function compact(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-GB")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 240);
}

function sameProvider(left: unknown, right: unknown): boolean {
  const a = compact(left);
  const b = compact(right);
  return Boolean(a && b && a === b);
}

/**
 * Unlike the message-derived key used by one-off cards, this key is tied to
 * one permanent TripDoc. Gmail can replace an itinerary message when a flight
 * moves; the reminder and Hub to-do must still be updated in place.
 */
export function appleMapsOfflinePreflightSourceKey(creationId: string): string {
  return createHash("sha256")
    .update("jarvis-apple-maps-offline-preflight-trip-v1\0")
    .update(String(creationId))
    .digest("hex");
}

export function appleMapsOfflineGmailIdentity(
  booking: ConfirmedBooking,
  selectionId: string,
): AppleMapsOfflineGmailIdentity {
  return {
    selectionId: String(selectionId).slice(0, 80),
    messageId: String(booking.id).slice(0, 240),
    marker: String(booking.marker).slice(0, 240),
    ...(booking.threadId ? { threadId: String(booking.threadId).slice(0, 240) } : {}),
    kind: String(booking.kind).slice(0, 40),
    provider: String(booking.provider).slice(0, 180),
    ...(booking.confirmationCode ? { confirmationCode: String(booking.confirmationCode).slice(0, 80) } : {}),
  };
}

/**
 * A replacement message is allowed only when it remains tied to the exact
 * Gmail thread or confirmation code originally selected by the owner. A broad
 * date/city match could silently attach a different journey, so it is never
 * used here.
 */
export function matchesAppleMapsOfflineGmailIdentity(
  booking: ConfirmedBooking,
  identity: AppleMapsOfflineGmailIdentity,
): boolean {
  if (booking.kind !== identity.kind) return false;
  if (String(booking.id) === identity.messageId && String(booking.marker) === identity.marker) return true;
  if (!sameProvider(booking.provider, identity.provider)) return false;
  const confirmationMatches = Boolean(identity.confirmationCode)
    && compact(booking.confirmationCode) === compact(identity.confirmationCode);
  return Boolean(
    (identity.threadId && booking.threadId === identity.threadId && confirmationMatches)
    || confirmationMatches,
  );
}

/**
 * A location change is consequential for the city handoff. The background
 * refresh can safely keep a reminder current only while the independently
 * geocoded stay proof continues to identify the same stay. Any change is
 * surfaced as pending owner refresh instead of guessing a new city.
 */
export function matchesAppleMapsOfflineCityProof(
  booking: ConfirmedBooking,
  proof: AppleMapsOfflineCityProof,
): boolean {
  if (booking.kind !== "stay") return false;
  if (!Number.isFinite(Number(booking.start)) || !Number.isFinite(Number(booking.end))) return false;
  if (Math.abs(Number(booking.start) - proof.start) > 24 * 60 * 60_000) return false;
  if (Math.abs(Number(booking.end) - proof.end) > 24 * 60 * 60_000) return false;
  const locationMatches = compact(booking.location) === compact(proof.location);
  const nameMatches = compact(booking.bookingName) === compact(proof.bookingName)
    || compact(booking.title) === compact(proof.title);
  return Boolean(locationMatches && nameMatches);
}

export function currentAppleMapsOfflineCityProof(
  proof: AppleMapsOfflineCityProof | undefined,
  now = Date.now(),
): AppleMapsOfflineCityProof | undefined {
  if (!proof || !compact(proof.city) || !compact(proof.location) || !Number.isFinite(proof.start) || !Number.isFinite(proof.end)) return undefined;
  if (!Number.isFinite(proof.verifiedAt) || proof.verifiedAt > now || proof.end < now) return undefined;
  return proof;
}
