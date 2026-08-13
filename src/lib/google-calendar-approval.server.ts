import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GoogleCalendarCreateInput } from "./google-calendar";
import { GOOGLE_CALENDAR_APPROVAL_MARKER } from "./sanitize";

const APPROVAL_VERSION = 1;
const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_TOKEN_BYTES = 4_096;

export class GoogleCalendarApprovalError extends Error {}

type ApprovalPayload = {
  version: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  event: GoogleCalendarCreateInput;
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
  const reminder = input.reminderMinutesBefore;
  if (reminder != null && (!Number.isInteger(reminder) || (reminder as number) < 1 || (reminder as number) > 40_320)) {
    throw new GoogleCalendarApprovalError("Calendar approval has an invalid reminder.");
  }
  return {
    title,
    start,
    end,
    allDay: input.allDay,
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(reminder != null ? { reminderMinutesBefore: reminder as number } : {}),
  };
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", approvalKey()).update(encodedPayload).digest();
}

/**
 * A tool call can prepare an event but never create one. This short-lived,
 * signed receipt is consumed only by a same-origin owner click in the UI.
 * Replays are harmless because the Calendar insert itself has a deterministic
 * idempotency key.
 */
export function issueGoogleCalendarApproval(input: GoogleCalendarCreateInput, now = Date.now()): string {
  const event = normalizedEvent(input);
  const payload: ApprovalPayload = {
    version: APPROVAL_VERSION,
    issuedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
    event,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
}

export function verifyGoogleCalendarApproval(token: unknown, now = Date.now()): GoogleCalendarCreateInput {
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
  let payload: ApprovalPayload;
  try {
    const raw = Buffer.from(parts[0], "base64url");
    if (!raw.byteLength || raw.byteLength > 3_000 || raw.toString("base64url") !== parts[0]) throw new Error("invalid encoding");
    payload = JSON.parse(raw.toString("utf8")) as ApprovalPayload;
  } catch {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  if (
    !payload ||
    payload.version !== APPROVAL_VERSION ||
    !Number.isFinite(payload.issuedAt) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt < now ||
    payload.expiresAt - payload.issuedAt !== APPROVAL_TTL_MS ||
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce)
  ) {
    throw new GoogleCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  return normalizedEvent(payload.event);
}

export function googleCalendarApprovalMarker(token: string): string {
  return `[${GOOGLE_CALENDAR_APPROVAL_MARKER}:${token}]`;
}
