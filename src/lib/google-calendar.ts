import "server-only";

import { createHash } from "node:crypto";
import { getGoogleAccessTokenForScopes } from "./google-oauth";
import { GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE } from "./google-scopes";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const PRIMARY_CALENDAR = "primary";
const LONDON = "Europe/London";
const DAY_MS = 86_400_000;
// A 31-calendar-day London window can differ from 31 × 24 hours by one DST
// transition. The small allowance preserves the calendar-day contract while
// still rejecting materially unbounded reads.
const MAX_LIST_RANGE_MS = 31 * DAY_MS + 2 * 60 * 60_000;
const MAX_LIST_RESULTS = 50;
const MANAGED_MARKER = "jarvis-google-calendar-v1";

export class GoogleCalendarError extends Error {}

export type GoogleCalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  /** True only when the provider proves this event was created by Jarvis. */
  managed?: true;
};

export type GoogleCalendarCreateInput = {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  /** IANA time zone for a time-sensitive event; defaults to Europe/London. */
  timeZone?: string;
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
  /** Server-derived, opaque source key used only for idempotent imports. */
  sourceDedupeKey?: string;
};

type GoogleCalendarEventWithMetadata = GoogleCalendarEvent & {
  privateProperties: Record<string, string>;
  etag?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function calendarUrl(path: string, query?: Record<string, string>): URL {
  const url = new URL(`${CALENDAR_API}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  return url;
}

async function calendarFetch(path: string, init?: RequestInit, query?: Record<string, string>): Promise<Response> {
  const token = await getGoogleAccessTokenForScopes([GOOGLE_CALENDAR_EVENTS_OWNED_SCOPE]);
  const headers = new Headers(init?.headers);
  // These are a hard server-side boundary, not caller-configurable request
  // options. Future internal callers cannot accidentally swap the bearer or
  // make a JSON body look like another format.
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return await fetch(calendarUrl(path, query), {
    ...init,
    headers,
    cache: "no-store",
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({}));
  return asRecord(payload);
}

function responseError(response: Response): GoogleCalendarError {
  // Do not reflect provider payloads: descriptions can contain event data and
  // are not useful to the model for a recoverable authorization/API failure.
  return new GoogleCalendarError(`Google Calendar request failed (HTTP ${response.status}).`);
}

function privateProperties(event: Record<string, unknown>): Record<string, string> {
  const extended = asRecord(event.extendedProperties);
  const privateValues = asRecord(extended.private);
  return Object.fromEntries(Object.entries(privateValues).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function mapEvent(value: unknown): GoogleCalendarEventWithMetadata {
  const event = asRecord(value);
  const id = optionalText(event.id);
  const start = asRecord(event.start);
  const end = asRecord(event.end);
  const startDateTime = optionalText(start.dateTime);
  const endDateTime = optionalText(end.dateTime);
  const startDate = optionalText(start.date);
  const endDate = optionalText(end.date);
  const timeZone = providerTimeZone(start.timeZone) ?? providerTimeZone(end.timeZone);
  if (!id || (!startDateTime && !startDate) || (!endDateTime && !endDate)) {
    throw new GoogleCalendarError("Google Calendar returned an incomplete event.");
  }
  return {
    id,
    title: optionalText(event.summary) ?? "Untitled event",
    start: startDateTime ?? startDate!,
    end: endDateTime ?? endDate!,
    allDay: !startDateTime,
    ...(timeZone ? { timeZone } : {}),
    ...(optionalText(event.location) ? { location: optionalText(event.location) } : {}),
    ...(optionalText(event.htmlLink) ? { htmlLink: optionalText(event.htmlLink) } : {}),
    ...(optionalText(event.status) ? { status: optionalText(event.status) } : {}),
    ...(optionalText(event.etag) ? { etag: optionalText(event.etag) } : {}),
    privateProperties: privateProperties(event),
  };
}

function requireBoundedText(value: unknown, label: string, maxLength: number, required = false): string | undefined {
  if (value == null) {
    if (required) throw new GoogleCalendarError(`${label} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new GoogleCalendarError(`${label} must be text.`);
  const text = value.trim();
  if (!text && required) throw new GoogleCalendarError(`${label} is required.`);
  if (text.length > maxLength) throw new GoogleCalendarError(`${label} must be at most ${maxLength} characters.`);
  return text || undefined;
}

function requireEpoch(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new GoogleCalendarError(`${label} must be a valid time.`);
  return value;
}

function validTimeZone(value: string): boolean {
  if (!/^[A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizedTimeZone(value: unknown): string | undefined {
  const timeZone = requireBoundedText(value, "Time zone", 80);
  if (!timeZone) return undefined;
  if (!validTimeZone(timeZone)) throw new GoogleCalendarError("Time zone must be a supported IANA time zone.");
  return timeZone;
}

function providerTimeZone(value: unknown): string | undefined {
  const timeZone = optionalText(value);
  return timeZone && timeZone.length <= 80 && validTimeZone(timeZone) ? timeZone : undefined;
}

function normalizedSourceDedupeKey(value: unknown): string | undefined {
  const sourceDedupeKey = requireBoundedText(value, "Source dedupe key", 64);
  if (!sourceDedupeKey) return undefined;
  if (!/^[a-f0-9]{64}$/.test(sourceDedupeKey)) {
    throw new GoogleCalendarError("Source dedupe key must be an opaque SHA-256 digest.");
  }
  return sourceDedupeKey;
}

function calendarDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function eventIdentity(input: {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
  sourceDedupeKey?: string;
}): { eventId: string; dedupeKey: string } {
  const { sourceDedupeKey, ...canonicalInput } = input;
  const canonical = JSON.stringify(canonicalInput);
  const dedupeKey = sourceDedupeKey ?? createHash("sha256").update(canonical).digest("hex");
  return { eventId: managedEventId(dedupeKey), dedupeKey };
}

function managedEventId(dedupeKey: string): string {
  // Google's allowed event-id alphabet is base32hex (a-v, 0-9). A SHA-256
  // hex digest is a valid subset, and the stable ID lets a retry resolve a
  // completed insert without creating a duplicate event.
  return `jarvis${dedupeKey}`;
}

function normalizedEventInput(input: GoogleCalendarCreateInput): GoogleCalendarCreateInput {
  const title = requireBoundedText(input.title, "Title", 140, true)!;
  const start = requireEpoch(input.start, "Start");
  const end = requireEpoch(input.end, "End");
  if (end <= start) throw new GoogleCalendarError("End must be after start.");
  if (typeof input.allDay !== "boolean") throw new GoogleCalendarError("All-day must be a boolean.");
  const location = requireBoundedText(input.location, "Location", 140);
  const notes = requireBoundedText(input.notes, "Notes", 500);
  const timeZone = normalizedTimeZone(input.timeZone);
  const sourceDedupeKey = normalizedSourceDedupeKey(input.sourceDedupeKey);
  const reminderMinutesBefore = input.reminderMinutesBefore;
  if (reminderMinutesBefore != null && (!Number.isInteger(reminderMinutesBefore) || reminderMinutesBefore < 1 || reminderMinutesBefore > 40_320)) {
    throw new GoogleCalendarError("Reminder must be a whole number from 1 to 40320 minutes.");
  }
  return {
    title,
    start,
    end,
    allDay: input.allDay,
    ...(timeZone ? { timeZone } : {}),
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(reminderMinutesBefore != null ? { reminderMinutesBefore } : {}),
    ...(sourceDedupeKey ? { sourceDedupeKey } : {}),
  };
}

function calendarEventFields(input: GoogleCalendarCreateInput): Record<string, unknown> {
  const timeZone = input.timeZone ?? LONDON;
  const startDate = calendarDate(input.start, timeZone);
  const endDate = calendarDate(input.end, timeZone);
  const allDayEnd = endDate > startDate ? endDate : addCalendarDays(startDate, 1);
  return {
    summary: input.title,
    ...(input.location ? { location: input.location } : {}),
    ...(input.notes ? { description: input.notes } : {}),
    start: input.allDay
      ? { date: startDate }
      : { dateTime: new Date(input.start).toISOString(), timeZone },
    end: input.allDay
      ? { date: allDayEnd }
      : { dateTime: new Date(input.end).toISOString(), timeZone },
    ...(input.reminderMinutesBefore != null
      ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: input.reminderMinutesBefore }] } }
      : {}),
  };
}

function publicEvent(event: GoogleCalendarEventWithMetadata): GoogleCalendarEvent {
  const { privateProperties: _privateProperties, etag: _etag, ...value } = event;
  return value;
}

function requireManagedEventId(eventId: string): string {
  if (!/^jarvis[a-v0-9]{5,1018}$/.test(eventId)) {
    throw new GoogleCalendarError("Only a managed Google Calendar event can be changed.");
  }
  return eventId;
}

function requireExpectedEtag(expectedEtag: string): string {
  if (typeof expectedEtag !== "string" || !expectedEtag || expectedEtag.length > 512 || !/^[\x21-\x7E]+$/.test(expectedEtag)) {
    throw new GoogleCalendarError("The managed Google Calendar event revision is invalid.");
  }
  return expectedEtag;
}

async function getManagedPrimaryEvent(eventId: string): Promise<GoogleCalendarEventWithMetadata | null> {
  const response = await calendarFetch(`/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}`, undefined, {
    fields: "id,etag,summary,start,end,location,status,htmlLink,extendedProperties/private",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw responseError(response);
  return mapEvent(await responseJson(response));
}

async function currentManagedEvent(eventId: string, expectedEtag?: string): Promise<GoogleCalendarEventWithMetadata | null> {
  requireManagedEventId(eventId);
  const existing = await getManagedPrimaryEvent(eventId);
  if (!existing) return null;
  if (existing.privateProperties.jarvisManaged !== MANAGED_MARKER || !existing.etag) {
    throw new GoogleCalendarError("Only a managed Google Calendar event can be changed.");
  }
  if (expectedEtag != null && existing.etag !== requireExpectedEtag(expectedEtag)) {
    throw new GoogleCalendarError("This managed Google Calendar event changed after the approval was prepared. Review it and request a fresh approval.");
  }
  return existing;
}

/** Reads a single provider-verified Jarvis event so a tool can seal its revision into an approval. */
export async function getManagedGooglePrimaryCalendarEvent(eventId: string): Promise<{ event: GoogleCalendarEvent; etag: string }> {
  const existing = await currentManagedEvent(eventId);
  if (!existing || !existing.etag) {
    throw new GoogleCalendarError("That managed Google Calendar event is no longer available.");
  }
  return { event: publicEvent(existing), etag: existing.etag };
}

/**
 * Looks up the one managed event reserved for a stable server-derived source
 * key. A matching private key is required before a caller can turn a fresh
 * owner approval into an ETag-fenced update instead of another create.
 */
export async function getManagedGooglePrimaryCalendarEventForSourceKey(
  sourceDedupeKey: string,
): Promise<{ event: GoogleCalendarEvent; etag: string } | null> {
  const dedupeKey = normalizedSourceDedupeKey(sourceDedupeKey);
  if (!dedupeKey) throw new GoogleCalendarError("Source dedupe key must be an opaque SHA-256 digest.");
  const existing = await currentManagedEvent(managedEventId(dedupeKey));
  if (!existing) return null;
  if (existing.privateProperties.jarvisDedupeKey !== dedupeKey || !existing.etag) {
    throw new GoogleCalendarError("That managed Google Calendar event does not match this source.");
  }
  return { event: publicEvent(existing), etag: existing.etag };
}

export async function listGooglePrimaryCalendarEvents(input: {
  start: number;
  end: number;
  maxResults?: number;
}): Promise<GoogleCalendarEvent[]> {
  const start = requireEpoch(input.start, "Start");
  const end = requireEpoch(input.end, "End");
  if (end <= start) throw new GoogleCalendarError("End must be after start.");
  if (end - start > MAX_LIST_RANGE_MS) throw new GoogleCalendarError("Google Calendar reads are limited to a 31-day window.");
  const requested = input.maxResults ?? 20;
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_LIST_RESULTS) {
    throw new GoogleCalendarError(`Google Calendar reads are limited to 1-${MAX_LIST_RESULTS} events.`);
  }

  const response = await calendarFetch(`/calendars/${PRIMARY_CALENDAR}/events`, undefined, {
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString(),
    maxResults: String(requested),
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    timeZone: LONDON,
    fields: "items(id,summary,start,end,location,status,htmlLink,extendedProperties/private)",
  });
  if (!response.ok) throw responseError(response);
  const items = asRecord(await responseJson(response)).items;
  if (!Array.isArray(items)) return [];
  return items.map(mapEvent).map((event) => ({
    ...publicEvent(event),
    ...(event.privateProperties.jarvisManaged === MANAGED_MARKER ? { managed: true as const } : {}),
  }));
}

export async function createGooglePrimaryCalendarEvent(input: GoogleCalendarCreateInput): Promise<{
  event: GoogleCalendarEvent;
  created: boolean;
}> {
  const eventInput = normalizedEventInput(input);
  const identity = eventIdentity(eventInput);
  const event = {
    id: identity.eventId,
    ...calendarEventFields(eventInput),
    // No attendee, conference, attachment, or URL field is accepted from a
    // tool call. `sendUpdates=none` below is a second guard against email.
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: {
      private: {
        jarvisManaged: MANAGED_MARKER,
        jarvisDedupeKey: identity.dedupeKey,
      },
    },
  };

  const response = await calendarFetch(
    `/calendars/${PRIMARY_CALENDAR}/events`,
    { method: "POST", body: JSON.stringify(event) },
    { sendUpdates: "none", conferenceDataVersion: "0" },
  );
  if (response.ok) {
    const created = mapEvent(await responseJson(response));
    return { event: publicEvent(created), created: true };
  }
  if (response.status !== 409) throw responseError(response);

  // A response can be lost after Google has committed the event. Look up our
  // deterministic ID and only call it a duplicate when the private marker
  // proves it is the exact same Jarvis request.
  const existing = await getManagedPrimaryEvent(identity.eventId);
  if (existing?.privateProperties.jarvisManaged === MANAGED_MARKER && existing.privateProperties.jarvisDedupeKey === identity.dedupeKey) {
    return { event: publicEvent(existing), created: false };
  }
  throw new GoogleCalendarError("Google Calendar rejected the event ID because it is already in use by another event.");
}

/** Changes a provider-verified Jarvis event only if the sealed revision still matches. */
export async function updateManagedGooglePrimaryCalendarEvent(input: {
  eventId: string;
  expectedEtag: string;
  event: GoogleCalendarCreateInput;
}): Promise<{ event: GoogleCalendarEvent }> {
  const eventId = requireManagedEventId(input.eventId);
  const eventInput = normalizedEventInput(input.event);
  const existing = await currentManagedEvent(eventId, input.expectedEtag);
  if (!existing) throw new GoogleCalendarError("That managed Google Calendar event is no longer available.");
  const eventWithExistingTimeZone = eventInput.timeZone || !existing.timeZone
    ? eventInput
    : { ...eventInput, timeZone: existing.timeZone };
  const response = await calendarFetch(
    `/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: { "If-Match": requireExpectedEtag(input.expectedEtag) },
      body: JSON.stringify({
        ...calendarEventFields(eventWithExistingTimeZone),
        // Preserve the private proof while refusing fields such as attendees,
        // conference data, attachments, or arbitrary URLs from tool input.
        guestsCanInviteOthers: false,
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
        extendedProperties: { private: existing.privateProperties },
      }),
    },
    { sendUpdates: "none", conferenceDataVersion: "0" },
  );
  if (response.status === 412) {
    throw new GoogleCalendarError("This managed Google Calendar event changed after the approval was prepared. Review it and request a fresh approval.");
  }
  if (!response.ok) throw responseError(response);
  return { event: publicEvent(mapEvent(await responseJson(response))) };
}

/** Deletes a provider-verified Jarvis event only if the sealed revision still matches. */
export async function deleteManagedGooglePrimaryCalendarEvent(eventId: string, expectedEtag: string): Promise<{ id: string; deleted: boolean }> {
  eventId = requireManagedEventId(eventId);
  const existing = await currentManagedEvent(eventId, expectedEtag);
  if (!existing) return { id: eventId, deleted: false };
  const response = await calendarFetch(
    `/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { "If-Match": requireExpectedEtag(expectedEtag) } },
    { sendUpdates: "none" },
  );
  if (response.status === 404) return { id: eventId, deleted: false };
  if (response.status === 412) {
    throw new GoogleCalendarError("This managed Google Calendar event changed after the approval was prepared. Review it and request a fresh approval.");
  }
  if (!response.ok) throw responseError(response);
  return { id: eventId, deleted: true };
}
