import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GoogleCalendarCreateInput } from "./google-calendar";
import { GOOGLE_CALENDAR_APPROVAL_MARKER } from "./sanitize";

const APPROVAL_VERSION = 2;
const LEGACY_APPROVAL_VERSION = 1;
const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_TOKEN_BYTES = 4_096;

export class GoogleCalendarApprovalError extends Error {}

/**
 * A short-lived Apple Maps Calendar approval must describe the exact saved
 * preflight that produced it. The approval route re-checks this binding before
 * it writes to Google, so a background itinerary refresh invalidates an older
 * card instead of creating an event at the previous flight time.
 */
export type AppleMapsOfflinePreflightApprovalBinding = {
  tripId: string;
  storage: "draft" | "creation";
  updatedAt: number;
  sourceKey: string;
};

export type GoogleCalendarApprovalProposal =
  | {
    action: "create";
    event: GoogleCalendarCreateInput;
    appleMapsOfflinePreflight?: AppleMapsOfflinePreflightApprovalBinding;
  }
  | {
    action: "update";
    eventId: string;
    expectedEtag: string;
    event: GoogleCalendarCreateInput;
    appleMapsOfflinePreflight?: AppleMapsOfflinePreflightApprovalBinding;
  }
  | { action: "delete"; eventId: string; expectedEtag: string };

export type VerifiedGoogleCalendarApproval = {
  proposal: GoogleCalendarApprovalProposal;
  nonce: string;
  expiresAt: number;
};

type ApprovalPayload = {
  version: typeof APPROVAL_VERSION;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  proposal: GoogleCalendarApprovalProposal;
};

function approvalKey(): Buffer {
  const configured = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!configured) throw new GoogleCalendarApprovalError("Google Calendar approval is not configured.");
  const encryptionKey = Buffer.from(configured, "base64");
  if (encryptionKey.byteLength !== 32) throw new GoogleCalendarApprovalError("Google Calendar approval is not configured.");
  return createHash("sha256")
    .update("jarvis-google-calendar-approval-v1\0")
    .update(encryptionKey)
    .digest();
}

function boundedText(value: unknown, label: string, maxLength: number, required = false): string | undefined {
  if (value == null) {
    if (required) throw new GoogleCalendarApprovalError(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new GoogleCalendarApprovalError(`${label} must be text.`);
  const text = value.trim();
  if (!text && required) throw new GoogleCalendarApprovalError(`${label} is required.`);
  if (text.length > maxLength) throw new GoogleCalendarApprovalError(`${label} is too long.`);
  return text || undefined;
}

function normalizedTimeZone(value: unknown): string | undefined {
  const timeZone = boundedText(value, "Time zone", 80);
  if (!timeZone) return undefined;
  if (!/^[A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+$/.test(timeZone)) {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid time zone.");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid time zone.");
  }
  return timeZone;
}

function normalizedSourceDedupeKey(value: unknown): string | undefined {
  const sourceDedupeKey = boundedText(value, "Source dedupe key", 64);
  if (!sourceDedupeKey) return undefined;
  if (!/^[a-f0-9]{64}$/.test(sourceDedupeKey)) {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid source dedupe key.");
  }
  return sourceDedupeKey;
}

function normalizedEvent(value: unknown): GoogleCalendarCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  }
  const input = value as Record<string, unknown>;
  const title = boundedText(input.title, "Title", 140, true)!;
  const start = input.start;
  const end = input.end;
  if (typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end) || end <= start) {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid time.");
  }
  if (typeof input.allDay !== "boolean") throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  const location = boundedText(input.location, "Location", 140);
  const notes = boundedText(input.notes, "Notes", 500);
  const timeZone = normalizedTimeZone(input.timeZone);
  const sourceDedupeKey = normalizedSourceDedupeKey(input.sourceDedupeKey);
  const reminder = input.reminderMinutesBefore;
  if (reminder != null && (!Number.isInteger(reminder) || (reminder as number) < 1 || (reminder as number) > 40_320)) {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid reminder.");
  }
  return {
    title,
    start,
    end,
    allDay: input.allDay,
    ...(timeZone ? { timeZone } : {}),
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(reminder != null ? { reminderMinutesBefore: reminder as number } : {}),
    ...(sourceDedupeKey ? { sourceDedupeKey } : {}),
  };
}

function normalizedManagedEventId(value: unknown): string {
  const eventId = boundedText(value, "Managed event ID", 1_024, true)!;
  if (!/^jarvis[a-v0-9]{5,1018}$/.test(eventId)) {
    throw new GoogleCalendarApprovalError("Calendar approval can only change a managed event.");
  }
  return eventId;
}

function normalizedEtag(value: unknown): string {
  const etag = boundedText(value, "Event revision", 512, true)!;
  if (!/^[\x21-\x7E]+$/.test(etag)) {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid event revision.");
  }
  return etag;
}

function normalizedAppleMapsOfflinePreflightApprovalBinding(value: unknown): AppleMapsOfflinePreflightApprovalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  }
  const input = value as Record<string, unknown>;
  const tripId = boundedText(input.tripId, "Trip ID", 256, true)!;
  const sourceKey = normalizedSourceDedupeKey(input.sourceKey);
  if (!sourceKey) throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  if (input.storage !== "draft" && input.storage !== "creation") {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  }
  if (typeof input.updatedAt !== "number" || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  }
  return { tripId, storage: input.storage, updatedAt: input.updatedAt, sourceKey };
}

function normalizedProposal(value: unknown): GoogleCalendarApprovalProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
  }
  const input = value as Record<string, unknown>;
  if (input.action === "create") {
    const appleMapsOfflinePreflight = Object.hasOwn(input, "appleMapsOfflinePreflight")
      ? normalizedAppleMapsOfflinePreflightApprovalBinding(input.appleMapsOfflinePreflight)
      : undefined;
    return {
      action: "create",
      event: normalizedEvent(input.event),
      ...(appleMapsOfflinePreflight ? { appleMapsOfflinePreflight } : {}),
    };
  }
  if (input.action === "update") {
    const appleMapsOfflinePreflight = Object.hasOwn(input, "appleMapsOfflinePreflight")
      ? normalizedAppleMapsOfflinePreflightApprovalBinding(input.appleMapsOfflinePreflight)
      : undefined;
    return {
      action: "update",
      eventId: normalizedManagedEventId(input.eventId),
      expectedEtag: normalizedEtag(input.expectedEtag),
      event: normalizedEvent(input.event),
      ...(appleMapsOfflinePreflight ? { appleMapsOfflinePreflight } : {}),
    };
  }
  if (input.action === "delete") {
    return {
      action: "delete",
      eventId: normalizedManagedEventId(input.eventId),
      expectedEtag: normalizedEtag(input.expectedEtag),
    };
  }
  throw new GoogleCalendarApprovalError("Calendar approval is invalid.");
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", approvalKey()).update(encodedPayload).digest();
}

function verifyPayload(token: unknown, now: number): { payload: Record<string, unknown>; nonce: string; expiresAt: number } {
  if (typeof token !== "string" || token.length < 40 || token.length > MAX_TOKEN_BYTES) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  const actualSignature = Buffer.from(parts[1], "base64url");
  const expectedSignature = sign(parts[0]);
  if (
    actualSignature.toString("base64url") !== parts[1] ||
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  let payload: Record<string, unknown>;
  try {
    const raw = Buffer.from(parts[0], "base64url");
    if (!raw.byteLength || raw.byteLength > 3_000 || raw.toString("base64url") !== parts[0]) throw new Error("invalid encoding");
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  const issuedAt = payload.issuedAt;
  const expiresAt = payload.expiresAt;
  const nonce = payload.nonce;
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    (expiresAt as number) < now ||
    (expiresAt as number) - (issuedAt as number) !== APPROVAL_TTL_MS ||
    typeof nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)
  ) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  return { payload, nonce, expiresAt: expiresAt as number };
}

/**
 * A tool can prepare a change but cannot write it. The receipt is accepted
 * only from a same-origin owner click. Update/delete proposals additionally
 * seal Google Calendar's observed revision; a stale or replayed write loses
 * its If-Match race instead of overwriting a changed plan.
 */
export function issueGoogleCalendarApprovalProposal(proposal: GoogleCalendarApprovalProposal, now = Date.now()): string {
  const payload: ApprovalPayload = {
    version: APPROVAL_VERSION,
    issuedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
    proposal: normalizedProposal(proposal),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
}

/** Backward-compatible create helper used by existing callers and cards. */
export function issueGoogleCalendarApproval(input: GoogleCalendarCreateInput, now = Date.now()): string {
  return issueGoogleCalendarApprovalProposal({ action: "create", event: input }, now);
}

export function verifyGoogleCalendarApprovalProposal(token: unknown, now = Date.now()): VerifiedGoogleCalendarApproval {
  const { payload, nonce, expiresAt } = verifyPayload(token, now);
  if (payload.version === LEGACY_APPROVAL_VERSION) {
    // Keep already-rendered v1 create cards valid for their short remaining TTL.
    return { proposal: { action: "create", event: normalizedEvent(payload.event) }, nonce, expiresAt };
  }
  if (payload.version !== APPROVAL_VERSION) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  return { proposal: normalizedProposal(payload.proposal), nonce, expiresAt };
}

/** Retained for callers that prepare only a new event. */
export function verifyGoogleCalendarApproval(token: unknown, now = Date.now()): GoogleCalendarCreateInput {
  const approval = verifyGoogleCalendarApprovalProposal(token, now);
  if (approval.proposal.action !== "create") {
    throw new GoogleCalendarApprovalError("Calendar approval is not a create request.");
  }
  return approval.proposal.event;
}

export function googleCalendarApprovalMarker(token: string): string {
  return `[${GOOGLE_CALENDAR_APPROVAL_MARKER}:${token}]`;
}
