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
  location?: string;
  htmlLink?: string;
  status?: string;
};

export type GoogleCalendarCreateInput = {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
};

type GoogleCalendarEventWithMetadata = GoogleCalendarEvent & {
  privateProperties: Record<string, string>;
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
  if (!id || (!startDateTime && !startDate) || (!endDateTime && !endDate)) {
    throw new GoogleCalendarError("Google Calendar returned an incomplete event.");
  }
  return {
    id,
    title: optionalText(event.summary) ?? "Untitled event",
    start: startDateTime ?? startDate!,
    end: endDateTime ?? endDate!,
    allDay: !startDateTime,
    ...(optionalText(event.location) ? { location: optionalText(event.location) } : {}),
    ...(optionalText(event.htmlLink) ? { htmlLink: optionalText(event.htmlLink) } : {}),
    ...(optionalText(event.status) ? { status: optionalText(event.status) } : {}),
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

function londonDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
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
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
}): { eventId: string; dedupeKey: string } {
  const canonical = JSON.stringify(input);
  const dedupeKey = createHash("sha256").update(canonical).digest("hex");
  // Google's allowed event-id alphabet is base32hex (a-v, 0-9). A SHA-256
  // hex digest is a valid subset, and the stable ID lets a retry resolve a
  // completed insert without creating a duplicate event.
  return { eventId: `jarvis${dedupeKey}`, dedupeKey };
}

async function getManagedPrimaryEvent(eventId: string): Promise<GoogleCalendarEventWithMetadata | null> {
  const response = await calendarFetch(`/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}`, undefined, {
    fields: "id,summary,start,end,location,status,htmlLink,extendedProperties/private",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw responseError(response);
  return mapEvent(await responseJson(response));
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
    fields: "items(id,summary,start,end,location,status,htmlLink)",
  });
  if (!response.ok) throw responseError(response);
  const items = asRecord(await responseJson(response)).items;
  if (!Array.isArray(items)) return [];
  return items.map(mapEvent).map(({ privateProperties: _privateProperties, ...event }) => event);
}

export async function createGooglePrimaryCalendarEvent(input: GoogleCalendarCreateInput): Promise<{
  event: GoogleCalendarEvent;
  created: boolean;
}> {
  const title = requireBoundedText(input.title, "Title", 140, true)!;
  const start = requireEpoch(input.start, "Start");
  const end = requireEpoch(input.end, "End");
  if (end <= start) throw new GoogleCalendarError("End must be after start.");
  if (typeof input.allDay !== "boolean") throw new GoogleCalendarError("All-day must be a boolean.");
  const location = requireBoundedText(input.location, "Location", 140);
  const notes = requireBoundedText(input.notes, "Notes", 500);
  const reminder = input.reminderMinutesBefore;
  if (reminder != null && (!Number.isInteger(reminder) || reminder < 1 || reminder > 40_320)) {
    throw new GoogleCalendarError("Reminder must be a whole number from 1 to 40320 minutes.");
  }

  const identity = eventIdentity({
    title,
    start,
    end,
    allDay: input.allDay,
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(reminder != null ? { reminderMinutesBefore: reminder } : {}),
  });
  const startDate = londonDate(start);
  const endDate = londonDate(end);
  const allDayEnd = endDate > startDate ? endDate : addCalendarDays(startDate, 1);
  const event = {
    id: identity.eventId,
    summary: title,
    ...(location ? { location } : {}),
    ...(notes ? { description: notes } : {}),
    start: input.allDay
      ? { date: startDate }
      : { dateTime: new Date(start).toISOString(), timeZone: LONDON },
    end: input.allDay
      ? { date: allDayEnd }
      : { dateTime: new Date(end).toISOString(), timeZone: LONDON },
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
    ...(reminder != null ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: reminder }] } } : {}),
  };

  const response = await calendarFetch(
    `/calendars/${PRIMARY_CALENDAR}/events`,
    { method: "POST", body: JSON.stringify(event) },
    { sendUpdates: "none", conferenceDataVersion: "0" },
  );
  if (response.ok) {
    const created = mapEvent(await responseJson(response));
    const { privateProperties: _privateProperties, ...publicEvent } = created;
    return { event: publicEvent, created: true };
  }
  if (response.status !== 409) throw responseError(response);

  // A response can be lost after Google has committed the event. Look up our
  // deterministic ID and only call it a duplicate when the private marker
  // proves it is the exact same Jarvis request.
  const existing = await getManagedPrimaryEvent(identity.eventId);
  if (existing?.privateProperties.jarvisManaged === MANAGED_MARKER && existing.privateProperties.jarvisDedupeKey === identity.dedupeKey) {
    const { privateProperties: _privateProperties, ...publicEvent } = existing;
    return { event: publicEvent, created: false };
  }
  throw new GoogleCalendarError("Google Calendar rejected the event ID because it is already in use by another event.");
}

/**
 * Reserved for a future owner-approved deletion flow. It only deletes an
 * event bearing Jarvis's private marker and is intentionally not exposed as a
 * chat tool until there is a durable interactive approval receipt.
 */
export async function deleteManagedGooglePrimaryCalendarEvent(eventId: string): Promise<{ id: string; deleted: boolean }> {
  if (!/^jarvis[a-v0-9]{5,1018}$/.test(eventId)) {
    throw new GoogleCalendarError("Only a managed Google Calendar event can be deleted.");
  }
  const existing = await getManagedPrimaryEvent(eventId);
  if (!existing) return { id: eventId, deleted: false };
  if (existing.privateProperties.jarvisManaged !== MANAGED_MARKER) {
    throw new GoogleCalendarError("Only a managed Google Calendar event can be deleted.");
  }
  const response = await calendarFetch(`/calendars/${PRIMARY_CALENDAR}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }, {
    sendUpdates: "none",
  });
  if (response.status === 404) return { id: eventId, deleted: false };
  if (!response.ok) throw responseError(response);
  return { id: eventId, deleted: true };
}
