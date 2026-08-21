import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ICLOUD_CALENDAR_APPROVAL_MARKER } from "./sanitize";

const APPROVAL_VERSION = 1;
const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_TOKEN_BYTES = 4_096;

export class ICloudCalendarApprovalError extends Error {}

export type ICloudCalendarApprovalEvent = {
  calendar?: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
};

export type VerifiedICloudCalendarApproval = {
  event: ICloudCalendarApprovalEvent;
  nonce: string;
  expiresAt: number;
};

type ApprovalPayload = {
  version: typeof APPROVAL_VERSION;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  event: ICloudCalendarApprovalEvent;
};

function approvalKey(): Buffer {
  const appleId = process.env.ICLOUD_CALENDAR_APPLE_ID?.trim();
  const appPassword = process.env.ICLOUD_CALENDAR_APP_PASSWORD?.trim();
  if (!appleId || !appPassword) {
    throw new ICloudCalendarApprovalError("iCloud Calendar approval is not configured.");
  }
  // Keep this receipt domain separate from every other approval token. The
  // server-only iCloud credential pair avoids adding a third secret solely to
  // sign a short-lived card; rotating the app password invalidates old cards.
  return createHash("sha256")
    .update("jarvis-icloud-calendar-approval-v1\0")
    .update(appleId)
    .update("\0")
    .update(appPassword)
    .digest();
}

function boundedText(value: unknown, label: string, maxLength: number, required = false): string | undefined {
  if (value == null) {
    if (required) throw new ICloudCalendarApprovalError(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new ICloudCalendarApprovalError(`${label} must be text.`);
  const text = value.trim();
  if (!text && required) throw new ICloudCalendarApprovalError(`${label} is required.`);
  if (text.length > maxLength) throw new ICloudCalendarApprovalError(`${label} is too long.`);
  return text || undefined;
}

function normalizedEvent(value: unknown): ICloudCalendarApprovalEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ICloudCalendarApprovalError("Calendar approval is invalid.");
  }
  const input = value as Record<string, unknown>;
  const title = boundedText(input.title, "Title", 140, true)!;
  const calendar = boundedText(input.calendar, "Calendar", 140);
  const location = boundedText(input.location, "Location", 140);
  const notes = boundedText(input.notes, "Notes", 500);
  const start = input.start;
  const end = input.end;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || (start as number) < 0
    || (end as number) <= (start as number)
  ) {
    throw new ICloudCalendarApprovalError("Calendar approval has an invalid time.");
  }
  if (typeof input.allDay !== "boolean") throw new ICloudCalendarApprovalError("Calendar approval is invalid.");
  const reminder = input.reminderMinutesBefore;
  if (reminder != null && (!Number.isInteger(reminder) || (reminder as number) < 1 || (reminder as number) > 40_320)) {
    throw new ICloudCalendarApprovalError("Calendar approval has an invalid reminder.");
  }
  return {
    title,
    start: start as number,
    end: end as number,
    allDay: input.allDay,
    ...(calendar ? { calendar } : {}),
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(reminder != null ? { reminderMinutesBefore: reminder as number } : {}),
  };
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", approvalKey()).update(encodedPayload).digest();
}

function encodedApprovalToken(payload: ApprovalPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const token = `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new ICloudCalendarApprovalError("iCloud Calendar approval is too large.");
  }
  return token;
}

/**
 * A tool may prepare an exact event, but only a same-origin owner click can
 * redeem this short-lived receipt. Its nonce is also the provider write's
 * idempotency key, so retried clicks cannot create a second event.
 */
export function issueICloudCalendarApproval(
  event: ICloudCalendarApprovalEvent,
  now = Date.now(),
): string {
  return encodedApprovalToken({
    version: APPROVAL_VERSION,
    issuedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
    event: normalizedEvent(event),
  });
}

export function verifyICloudCalendarApproval(token: unknown, now = Date.now()): VerifiedICloudCalendarApproval {
  if (typeof token !== "string" || token.length < 40 || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new ICloudCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    throw new ICloudCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  const actualSignature = Buffer.from(parts[1], "base64url");
  const expectedSignature = sign(parts[0]);
  if (
    actualSignature.toString("base64url") !== parts[1]
    || actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new ICloudCalendarApprovalError("Calendar approval is invalid or expired.");
  }

  let payload: Record<string, unknown>;
  try {
    const raw = Buffer.from(parts[0], "base64url");
    if (!raw.byteLength || raw.byteLength > 3_000 || raw.toString("base64url") !== parts[0]) throw new Error("invalid encoding");
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new ICloudCalendarApprovalError("Calendar approval is invalid or expired.");
  }

  const issuedAt = payload.issuedAt;
  const expiresAt = payload.expiresAt;
  const nonce = payload.nonce;
  if (
    payload.version !== APPROVAL_VERSION
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt)
    || (expiresAt as number) <= now
    || (expiresAt as number) - (issuedAt as number) !== APPROVAL_TTL_MS
    || typeof nonce !== "string"
    || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)
  ) {
    throw new ICloudCalendarApprovalError("Calendar approval is invalid or expired.");
  }
  return { event: normalizedEvent(payload.event), nonce, expiresAt: expiresAt as number };
}

export function iCloudCalendarApprovalMarker(token: string): string {
  return `[${ICLOUD_CALENDAR_APPROVAL_MARKER}:${token}]`;
}
