import "server-only";

import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { parseIcsVevents } from "./ics";
import { getServiceSecrets } from "./vault";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";
const LONDON = "Europe/London";
const XML = '<?xml version="1.0" encoding="utf-8"?>';

// Apple redirects CalDAV discovery to numbered iCloud CalDAV shards. Do not
// let a provider-controlled Location or DAV href turn into an authenticated
// request anywhere else: every CalDAV request carries the app password.
const ICLOUD_CALDAV_HOST = "caldav.icloud.com";
const ICLOUD_CALDAV_SHARD = /^p\d+-caldav\.icloud\.com$/;
const APPLE_CALENDAR_VAULT_SERVICE = "apple_calendar";

export type ICloudCalendar = { name: string; url: string; color?: string };
export type ICloudEvent = {
  uid: string;
  title: string;
  start: number;
  end?: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  eventUrl: string;
  etag?: string;
  calendarName: string;
  source: "icloud";
};

export type ICloudEventInput = {
  calendar?: string;
  title: string;
  start: number;
  end?: number;
  allDay?: boolean;
  location?: string;
  notes?: string;
  reminderMinutesBefore?: number;
  /** A signed approval nonce makes a retry target the same iCloud resource. */
  idempotencyKey?: string;
};

export type ICloudEventWriteResult = ICloudEvent & { created: boolean };

/**
 * Saved Apple Maps preflights use one deterministic CalDAV resource per
 * source key. Unlike the generic owner-approved event path, this lets a
 * refreshed itinerary update the same event without trusting a broad calendar
 * search or accidentally creating a second handoff reminder.
 */
export type ICloudTravelCalendarEventInput = {
  action: "create" | "update";
  calendarUrl: string;
  sourceKey: string;
  revision: number;
  nonce: string;
  event: Omit<ICloudEventInput, "calendar" | "idempotencyKey">;
  eventUrl?: string;
  expectedEtag?: string;
};

export type ICloudTravelCalendarEventWriteResult = Omit<ICloudEventWriteResult, "etag"> & {
  calendarUrl: string;
  revision: number;
  etag: string;
};

type XmlRecord = Record<string, unknown>;

let calendarHomeCache: { value: string; expiresAt: number } | null = null;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
});

export class ICloudCalendarError extends Error {}

/** A conditional CalDAV write found a different external revision. */
export class ICloudCalendarConflictError extends ICloudCalendarError {}

export async function iCloudCalendarConfigured(): Promise<boolean> {
  try {
    await credentials();
    return true;
  } catch {
    return false;
  }
}

async function credentials(): Promise<{ appleId: string; appPassword: string }> {
  // Production uses Project Hub as the credential authority. Do not silently
  // fall back to a copied environment value when that capability is present:
  // an allowlist/configuration failure must leave Calendar unavailable.
  if (process.env.VAULT_ACCESS_TOKEN?.trim()) {
    let secrets: Record<string, string>;
    try {
      secrets = await getServiceSecrets(APPLE_CALENDAR_VAULT_SERVICE);
    } catch {
      throw new ICloudCalendarError("iCloud Calendar credentials are unavailable from Project Hub Vault.");
    }
    const appleId = secrets.APPLE_ID?.trim();
    const appPassword = secrets.APPLE_APP_PASSWORD?.trim();
    if (!appleId || !appPassword) {
      throw new ICloudCalendarError("Project Hub Vault is missing the iCloud Calendar credential pair.");
    }
    return { appleId, appPassword };
  }

  const appleId = process.env.ICLOUD_CALENDAR_APPLE_ID?.trim();
  const appPassword = process.env.ICLOUD_CALENDAR_APP_PASSWORD?.trim();
  if (!appleId || !appPassword) {
    throw new ICloudCalendarError("iCloud Calendar is not configured in this cloud runtime.");
  }
  return { appleId, appPassword };
}

function xmlBody(parts: string): string {
  return XML + parts;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): XmlRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as XmlRecord) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function property(response: XmlRecord, propertyName: string): unknown {
  for (const propstat of toArray<XmlRecord>(asRecord(response.propstat))) {
    if (!text(propstat.status).includes(" 200 ")) continue;
    const props = asRecord(propstat.prop);
    if (propertyName in props) return props[propertyName];
  }
  return undefined;
}

function href(value: unknown): string {
  if (typeof value === "string") return value;
  return text(asRecord(value).href);
}

async function authHeader(): Promise<string> {
  const { appleId, appPassword } = await credentials();
  return `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString("base64")}`;
}

function trustedICloudCalDavUrl(value: string, base?: string): string {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new ICloudCalendarError("iCloud returned an invalid Calendar location.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || (hostname !== ICLOUD_CALDAV_HOST && !ICLOUD_CALDAV_SHARD.test(hostname))
  ) {
    throw new ICloudCalendarError("iCloud returned a Calendar location outside its CalDAV service.");
  }
  return url.toString();
}

async function caldavRequest(
  method: string,
  url: string,
  options: {
    body?: BodyInit;
    depth?: "0" | "1";
    headers?: HeadersInit;
    allowedStatuses?: readonly number[];
    /** Saved-trip resources must never follow a redirect to another child. */
    expectedUrl?: string;
  } = {},
): Promise<{ response: Response; url: string }> {
  // Validate before building Authorization, not merely before following a
  // redirect. This is the credential boundary for every caller, including
  // provider-discovered principal, home, calendar, and event URLs.
  let current = trustedICloudCalDavUrl(url);
  const expectedUrl = options.expectedUrl ? trustedICloudCalDavUrl(options.expectedUrl) : undefined;
  if (expectedUrl && current !== expectedUrl) {
    throw new ICloudCalendarConflictError("iCloud changed the sealed Calendar event location before approval.");
  }
  const authorization = await authHeader();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const headers = new Headers({
      Authorization: authorization,
      Accept: "application/xml, text/calendar;q=0.9, */*;q=0.1",
      "User-Agent": "JARVIS-iCloud-Calendar/1.0",
      ...(options.body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
      ...(options.depth ? { Depth: options.depth } : {}),
      ...options.headers,
    });
    const response = await fetch(current, {
      method,
      headers,
      body: options.body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ICloudCalendarError("iCloud redirected without a calendar location.");
      const redirected = trustedICloudCalDavUrl(location, current);
      // Check before the next authenticated fetch. A final-url assertion after
      // fetch is too late because PUT would already have changed a different
      // resource.
      if (expectedUrl && redirected !== expectedUrl) {
        throw new ICloudCalendarConflictError("iCloud changed the sealed Calendar event location before approval.");
      }
      current = redirected;
      continue;
    }
    if ([401, 403].includes(response.status)) throw new ICloudCalendarError("iCloud rejected the calendar credential.");
    if (!response.ok && response.status !== 207 && !options.allowedStatuses?.includes(response.status)) {
      const detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 180);
      throw new ICloudCalendarError(`iCloud Calendar returned HTTP ${response.status}${detail ? `: ${detail}` : ""}.`);
    }
    return { response, url: current };
  }
  throw new ICloudCalendarError("iCloud Calendar redirected too many times.");
}

function parseXml(source: string): XmlRecord {
  try {
    return asRecord(parser.parse(source));
  } catch {
    throw new ICloudCalendarError("iCloud returned an unreadable calendar response.");
  }
}

function responseRows(source: string): XmlRecord[] {
  const document = parseXml(source);
  return toArray(asRecord(document.multistatus).response).map(asRecord);
}

async function calendarHome(): Promise<string> {
  if (calendarHomeCache && calendarHomeCache.expiresAt > Date.now()) return calendarHomeCache.value;
  const body = xmlBody(
    `<D:propfind xmlns:D="${DAV}" xmlns:C="${CALDAV}"><D:prop><D:current-user-principal/><C:calendar-home-set/></D:prop></D:propfind>`,
  );
  let { response, url } = await caldavRequest("PROPFIND", ICLOUD_CALDAV_URL, { body, depth: "0" });
  let row = responseRows(await response.text())[0] ?? {};
  let home = href(property(row, "calendar-home-set"));
  if (!home) {
    const principal = href(property(row, "current-user-principal"));
    if (!principal) throw new ICloudCalendarError("iCloud did not return a calendar principal.");
    ({ response, url } = await caldavRequest("PROPFIND", trustedICloudCalDavUrl(principal, url), { body, depth: "0" }));
    row = responseRows(await response.text())[0] ?? {};
    home = href(property(row, "calendar-home-set"));
  }
  if (!home) throw new ICloudCalendarError("iCloud did not return a calendar home.");
  const value = trustedICloudCalDavUrl(home, url);
  calendarHomeCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

export async function listICloudCalendars(): Promise<ICloudCalendar[]> {
  const home = await calendarHome();
  const body = xmlBody(
    `<D:propfind xmlns:D="${DAV}" xmlns:C="${CALDAV}" xmlns:IC="http://apple.com/ns/ical/"><D:prop><D:displayname/><D:resourcetype/><IC:calendar-color/></D:prop></D:propfind>`,
  );
  const { response } = await caldavRequest("PROPFIND", home, { body, depth: "1" });
  return responseRows(await response.text())
    .filter((row) => {
      const resourceType = asRecord(property(row, "resourcetype"));
      return "calendar" in resourceType;
    })
    .map((row) => {
      const calendarUrl = href(row.href);
      return {
        name: text(property(row, "displayname")) || "Unnamed calendar",
        url: trustedICloudCalDavUrl(calendarUrl, home),
        color: text(property(row, "calendar-color")) || undefined,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function resolveCalendar(requested?: string): Promise<ICloudCalendar> {
  const calendars = await listICloudCalendars();
  if (!calendars.length) throw new ICloudCalendarError("No iCloud calendars are available.");
  if (!requested) return calendars.find((calendar) => calendar.name.toLowerCase() === "calendar") ?? calendars[0];
  const target = requested.trim().toLowerCase();
  const exact = calendars.find((calendar) => calendar.url === requested || calendar.name.toLowerCase() === target);
  if (exact) return exact;
  const partial = calendars.filter((calendar) => calendar.name.toLowerCase().includes(target));
  if (partial.length === 1) return partial[0];
  throw new ICloudCalendarError(`Calendar '${requested}' was not found.`);
}

// VEVENT parsing itself lives in ./ics (shared with src/lib/gmail.ts, Feature
// 4b, for .ics/text-calendar Gmail attachments) — this just adds the
// iCloud/CalDAV-specific wrapper fields.
function parseIcsEvents(source: string, eventUrl: string, calendarName: string, etag?: string): ICloudEvent[] {
  return parseIcsVevents(source).map((event) => ({
    ...event,
    eventUrl,
    etag,
    calendarName,
    source: "icloud" as const,
  }));
}

function toIcalUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function toLondonDate(epochMs: number): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}${values.month}${values.day}`;
}

function icalEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function calendarReportBody(start: number, end: number): string {
  return xmlBody(
    `<C:calendar-query xmlns:D="${DAV}" xmlns:C="${CALDAV}"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${toIcalUtc(start)}" end="${toIcalUtc(end)}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
  );
}

export async function listICloudEvents(start: number, end: number, requestedCalendar?: string): Promise<ICloudEvent[]> {
  const calendars = requestedCalendar ? [await resolveCalendar(requestedCalendar)] : await listICloudCalendars();
  const eventGroups = await Promise.all(
    calendars.map(async (calendar) => {
      const { response } = await caldavRequest("REPORT", calendar.url, { body: calendarReportBody(start, end), depth: "1" });
      const events: ICloudEvent[] = [];
      for (const row of responseRows(await response.text())) {
        const data = text(property(row, "calendar-data"));
        const resource = href(row.href);
        if (!data || !resource) continue;
        events.push(...parseIcsEvents(data, trustedICloudCalDavUrl(resource, calendar.url), calendar.name, text(property(row, "getetag")) || undefined));
      }
      return events;
    }),
  );
  const events = eventGroups.flat();
  return events.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title));
}

export async function createICloudEvent(input: ICloudEventInput): Promise<ICloudEventWriteResult> {
  const calendar = await resolveCalendar(input.calendar);
  const allDay = input.allDay === true;
  const end = input.end ?? input.start + (allDay ? 86_400_000 : 60 * 60_000);
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey && !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey)) {
    throw new ICloudCalendarError("iCloud Calendar idempotency key is invalid.");
  }
  const uid = idempotencyKey ? `jarvis-approval-${idempotencyKey}@jarvis` : `${randomUUID()}@jarvis`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JARVIS//iCloud Calendar//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${toIcalUtc(Date.now())}`];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toLondonDate(input.start)}`, `DTEND;VALUE=DATE:${toLondonDate(end)}`);
  } else {
    lines.push(`DTSTART:${toIcalUtc(input.start)}`, `DTEND:${toIcalUtc(end)}`);
  }
  lines.push(`SUMMARY:${icalEscape(input.title)}`);
  if (input.location) lines.push(`LOCATION:${icalEscape(input.location)}`);
  if (input.notes) lines.push(`DESCRIPTION:${icalEscape(input.notes)}`);
  if (input.reminderMinutesBefore && input.reminderMinutesBefore > 0) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icalEscape(input.title)}`, `TRIGGER:-PT${Math.min(14 * 24 * 60, Math.round(input.reminderMinutesBefore))}M`, "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  const eventUrl = new URL(`${uid}.ics`, calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`).toString();
  const { response } = await caldavRequest("PUT", eventUrl, {
    body: lines.join("\r\n"),
    headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" },
    // A retry after a lost response uses the exact receipt-nonce resource.
    // iCloud's conditional conflict means the original write already won.
    allowedStatuses: idempotencyKey ? [412] : undefined,
  });
  return {
    uid,
    title: input.title,
    start: input.start,
    end,
    allDay,
    location: input.location,
    notes: input.notes,
    eventUrl,
    etag: response.headers.get("etag") ?? undefined,
    calendarName: calendar.name,
    source: "icloud",
    created: response.status !== 412,
  };
}

function normalizedTravelCalendarUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) {
    throw new ICloudCalendarError("iCloud Calendar URL is invalid.");
  }
  let url: URL;
  try { url = new URL(trustedICloudCalDavUrl(value)); } catch {
    throw new ICloudCalendarError("iCloud Calendar URL is invalid.");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function travelEventUrlBelongsToCalendar(calendarUrl: string, eventUrl: unknown): string {
  if (typeof eventUrl !== "string" || eventUrl.length > 2_000) {
    throw new ICloudCalendarError("iCloud Calendar event URL is invalid.");
  }
  let event: URL;
  try {
    event = new URL(trustedICloudCalDavUrl(eventUrl));
  } catch {
    throw new ICloudCalendarError("iCloud Calendar event URL is invalid.");
  }
  const calendar = new URL(trustedICloudCalDavUrl(calendarUrl));
  if (
    event.protocol !== "https:"
    || event.username
    || event.password
    || event.search
    || event.hash
    || event.origin !== calendar.origin
    || !event.pathname.startsWith(calendar.pathname)
    || !event.pathname.endsWith(".ics")
  ) {
    throw new ICloudCalendarError("iCloud Calendar event URL is invalid.");
  }
  return event.toString();
}

function validTravelSourceKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTravelNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function validTravelRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validEtag(value: unknown): value is string {
  // `*` is a special If-Match wildcard, not an event revision. Only pass a
  // concrete entity tag through to the conditional CalDAV update.
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value !== "*"
    && /^"[^"\u0000-\u001f\u007f]*"$/.test(value);
}

function travelEventUid(sourceKey: string): string {
  return `jarvis-apple-maps-${sourceKey}@jarvis`;
}

function deterministicTravelEventUrl(calendarUrl: string, sourceKey: string): string {
  return new URL(`${travelEventUid(sourceKey)}.ics`, calendarUrl).toString();
}

function travelEventIcs(input: ICloudTravelCalendarEventInput, uid: string): string {
  const allDay = input.event.allDay === true;
  const end = input.event.end ?? input.event.start + (allDay ? 86_400_000 : 60 * 60_000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JARVIS//iCloud Calendar//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcalUtc(Date.now())}`,
  ];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toLondonDate(input.event.start)}`, `DTEND;VALUE=DATE:${toLondonDate(end)}`);
  } else {
    lines.push(`DTSTART:${toIcalUtc(input.event.start)}`, `DTEND:${toIcalUtc(end)}`);
  }
  lines.push(
    `SUMMARY:${icalEscape(input.event.title)}`,
    `X-JARVIS-APPLE-MAPS-SOURCE-KEY:${input.sourceKey}`,
    `X-JARVIS-APPLE-MAPS-REVISION:${input.revision}`,
    `X-JARVIS-APPLE-MAPS-NONCE:${input.nonce}`,
  );
  if (input.event.location) lines.push(`LOCATION:${icalEscape(input.event.location)}`);
  if (input.event.notes) lines.push(`DESCRIPTION:${icalEscape(input.event.notes)}`);
  if (input.event.reminderMinutesBefore && input.event.reminderMinutesBefore > 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icalEscape(input.event.title)}`,
      `TRIGGER:-PT${Math.min(14 * 24 * 60, Math.round(input.event.reminderMinutesBefore))}M`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

type ICloudTravelEventMarker = {
  sourceKey: string;
  revision: number;
  nonce: string;
};

function iCalendarProperty(body: string, name: string): string | undefined {
  const unfolded = body.replace(/\r?\n[ \t]/g, "");
  const match = new RegExp(`(?:^|\\n)${name}:([^\\r\\n]+)`, "i").exec(unfolded);
  return match?.[1]?.trim() || undefined;
}

function travelEventMarker(body: string): ICloudTravelEventMarker | null {
  const sourceKey = iCalendarProperty(body, "X-JARVIS-APPLE-MAPS-SOURCE-KEY");
  const revision = Number(iCalendarProperty(body, "X-JARVIS-APPLE-MAPS-REVISION"));
  const nonce = iCalendarProperty(body, "X-JARVIS-APPLE-MAPS-NONCE");
  if (!validTravelSourceKey(sourceKey) || !validTravelRevision(revision) || !validTravelNonce(nonce)) return null;
  return { sourceKey, revision, nonce };
}

function sameTravelEventMarker(left: ICloudTravelEventMarker | null, right: Pick<ICloudTravelCalendarEventInput, "sourceKey" | "revision" | "nonce">): boolean {
  return left !== null
    && left.sourceKey === right.sourceKey
    && left.revision === right.revision
    && left.nonce === right.nonce;
}

async function readTravelEvent(eventUrl: string): Promise<{ eventUrl: string; etag?: string; marker: ICloudTravelEventMarker | null } | null> {
  const { response, url } = await caldavRequest("GET", eventUrl, { allowedStatuses: [404], expectedUrl: eventUrl });
  if (response.status === 404) return null;
  const etag = response.headers.get("etag") ?? undefined;
  return { eventUrl: url, ...(etag ? { etag } : {}), marker: travelEventMarker(await response.text()) };
}

export type ICloudTravelCalendarAttemptMarker = {
  revision: number;
  nonce: string;
};

export type ICloudTravelCalendarAttemptInspection =
  | { state: "missing" }
  | { state: "present"; revision: number; nonce: string; etag: string };

/**
 * Read one previously sealed deterministic resource while recovering a lost
 * CalDAV/Convex hand-off. This never searches a calendar and accepts a result
 * only if its source key plus one durable attempt marker match exactly.
 */
export async function inspectICloudTravelCalendarAttempt(input: {
  calendarUrl: string;
  eventUrl: string;
  sourceKey: string;
  markers: readonly ICloudTravelCalendarAttemptMarker[];
}): Promise<ICloudTravelCalendarAttemptInspection> {
  if (!validTravelSourceKey(input.sourceKey) || !Array.isArray(input.markers) || input.markers.length < 1 || input.markers.length > 2
    || input.markers.some((marker) => !validTravelRevision(marker.revision) || !validTravelNonce(marker.nonce))) {
    throw new ICloudCalendarError("iCloud Calendar recovery attempt is invalid.");
  }
  const calendarUrl = normalizedTravelCalendarUrl(input.calendarUrl);
  const eventUrl = travelEventUrlBelongsToCalendar(calendarUrl, input.eventUrl);
  const existing = await readTravelEvent(eventUrl);
  if (!existing) return { state: "missing" };
  if (existing.eventUrl !== eventUrl || !validEtag(existing.etag)) {
    throw new ICloudCalendarConflictError("The Jarvis-managed iCloud Calendar event changed before approval.");
  }
  const matched = input.markers.find((marker) => sameTravelEventMarker(existing.marker, {
    sourceKey: input.sourceKey,
    revision: marker.revision,
    nonce: marker.nonce,
  }));
  if (!matched) throw new ICloudCalendarConflictError("The Jarvis-managed iCloud Calendar event changed before approval.");
  return { state: "present", revision: matched.revision, nonce: matched.nonce, etag: existing.etag };
}

async function resolvedTravelCalendar(calendarUrl: string): Promise<ICloudCalendar> {
  const calendar = await resolveCalendar(calendarUrl);
  if (normalizedTravelCalendarUrl(calendar.url) !== calendarUrl) {
    throw new ICloudCalendarConflictError("The selected iCloud Calendar changed before approval.");
  }
  return calendar;
}

/** Resolve a user-selected iCloud calendar once, before sealing a travel receipt. */
export async function resolveICloudTravelCalendar(requested?: string): Promise<ICloudCalendar> {
  const calendar = await resolveCalendar(requested);
  return { ...calendar, url: normalizedTravelCalendarUrl(calendar.url) };
}

/**
 * Conditional iCloud write for a saved Apple Maps preflight. The event URL is
 * deterministic for the stable source key; a retry can therefore distinguish
 * this receipt's lost response from someone else's existing Calendar event.
 */
export async function writeICloudTravelCalendarEvent(
  input: ICloudTravelCalendarEventInput,
): Promise<ICloudTravelCalendarEventWriteResult> {
  if (!validTravelSourceKey(input.sourceKey) || !validTravelRevision(input.revision) || !validTravelNonce(input.nonce)) {
    throw new ICloudCalendarError("iCloud travel calendar approval is invalid.");
  }
  const calendarUrl = normalizedTravelCalendarUrl(input.calendarUrl);
  const calendar = await resolvedTravelCalendar(calendarUrl);
  const uid = travelEventUid(input.sourceKey);
  const eventUrl = input.action === "create"
    ? deterministicTravelEventUrl(calendarUrl, input.sourceKey)
    : travelEventUrlBelongsToCalendar(calendarUrl, input.eventUrl);
  if (input.action === "update" && !validEtag(input.expectedEtag)) {
    throw new ICloudCalendarError("iCloud Calendar event revision is invalid.");
  }

  const { response, url } = await caldavRequest("PUT", eventUrl, {
    body: travelEventIcs(input, uid),
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      ...(input.action === "create" ? { "If-None-Match": "*" } : { "If-Match": input.expectedEtag! }),
    },
    // A 412 is never silently treated as success. It is safe only when a
    // follow-up read proves this exact receipt nonce and preflight revision won
    // a prior write whose HTTP response was lost.
    allowedStatuses: [412],
    expectedUrl: eventUrl,
  });
  const resolvedEventUrl = travelEventUrlBelongsToCalendar(calendarUrl, url);
  if (resolvedEventUrl !== eventUrl) {
    throw new ICloudCalendarConflictError("iCloud changed the sealed Calendar event location before approval.");
  }
  let created = response.status !== 412;
  let etag = response.headers.get("etag") ?? undefined;
  if (response.status === 412 || !validEtag(etag)) {
    const existing = await readTravelEvent(resolvedEventUrl);
    if (existing?.eventUrl !== resolvedEventUrl) {
      throw new ICloudCalendarConflictError("iCloud changed the sealed Calendar event location before approval.");
    }
    if (!sameTravelEventMarker(existing?.marker ?? null, input)) {
      throw new ICloudCalendarConflictError("The Jarvis-managed iCloud Calendar event changed before approval.");
    }
    if (!validEtag(existing?.etag)) {
      throw new ICloudCalendarError("iCloud Calendar did not return an event revision.");
    }
    // A missing ETag on a successful PUT still needs an exact verification
    // GET, but it did not make the create idempotent. Keep the owner-visible
    // result truthful; only an actual 412 proves a prior write won.
    if (response.status === 412) created = false;
    etag = existing.etag;
  }
  return {
    uid,
    title: input.event.title,
    start: input.event.start,
    end: input.event.end,
    allDay: input.event.allDay === true,
    ...(input.event.location ? { location: input.event.location } : {}),
    ...(input.event.notes ? { notes: input.event.notes } : {}),
    eventUrl: resolvedEventUrl,
    etag,
    calendarName: calendar.name,
    source: "icloud",
    created,
    calendarUrl,
    revision: input.revision,
  };
}

function eventUrlIsOwned(url: string, home: string): boolean {
  try {
    const candidate = new URL(trustedICloudCalDavUrl(url));
    const account = new URL(trustedICloudCalDavUrl(home));
    return candidate.protocol === "https:" && candidate.origin === account.origin && candidate.pathname.startsWith(account.pathname);
  } catch {
    return false;
  }
}

export async function deleteICloudEvent(eventUrl: string): Promise<void> {
  const home = await calendarHome();
  if (!eventUrlIsOwned(eventUrl, home)) throw new ICloudCalendarError("That event is not in Daniel's iCloud Calendar account.");
  await caldavRequest("DELETE", eventUrl);
}

export async function findICloudEvents(match: string, start: number, end: number): Promise<ICloudEvent[]> {
  const needle = match.trim().toLowerCase();
  if (!needle) return [];
  return (await listICloudEvents(start, end)).filter((event) => event.title.toLowerCase().includes(needle));
}
