import "server-only";

import { randomUUID } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";
const LONDON = "Europe/London";
const XML = '<?xml version="1.0" encoding="utf-8"?>';

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
};

type XmlRecord = Record<string, unknown>;
type IcalField = { name: string; value: string; params: Record<string, string> };

let calendarHomeCache: { value: string; expiresAt: number } | null = null;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
});

export class ICloudCalendarError extends Error {}

function credentials(): { appleId: string; appPassword: string } {
  const appleId = process.env.ICLOUD_CALENDAR_APPLE_ID;
  const appPassword = process.env.ICLOUD_CALENDAR_APP_PASSWORD;
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

function authHeader(): string {
  const { appleId, appPassword } = credentials();
  return `Basic ${Buffer.from(`${appleId}:${appPassword}`).toString("base64")}`;
}

async function caldavRequest(
  method: string,
  url: string,
  options: { body?: BodyInit; depth?: "0" | "1"; headers?: HeadersInit } = {},
): Promise<{ response: Response; url: string }> {
  let current = url;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const headers = new Headers({
      Authorization: authHeader(),
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
      current = new URL(location, current).toString();
      continue;
    }
    if ([401, 403].includes(response.status)) throw new ICloudCalendarError("iCloud rejected the calendar credential.");
    if (!response.ok && response.status !== 207) {
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
    ({ response, url } = await caldavRequest("PROPFIND", new URL(principal, url).toString(), { body, depth: "0" }));
    row = responseRows(await response.text())[0] ?? {};
    home = href(property(row, "calendar-home-set"));
  }
  if (!home) throw new ICloudCalendarError("iCloud did not return a calendar home.");
  const value = new URL(home, url).toString();
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
        url: new URL(calendarUrl, home).toString(),
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

function unfoldIcs(source: string): string[] {
  const lines: string[] = [];
  for (const raw of source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

function icalField(line: string): IcalField | null {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const fields = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const parameter of fields.slice(1)) {
    const [key, ...rest] = parameter.split("=");
    if (key && rest.length) params[key.toUpperCase()] = rest.join("=").replace(/^"|"$/g, "");
  }
  return { name: fields[0].toUpperCase(), value: line.slice(colon + 1), params };
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function londonTimeMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const interpreted = Date.UTC(Number(byType.year), Number(byType.month) - 1, Number(byType.day), Number(byType.hour), Number(byType.minute), Number(byType.second));
  guess -= interpreted - guess;
  return guess;
}

function calendarDayMs(value: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return Date.now();
  return londonTimeMs(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0);
}

function icalTimeMs(value: string, timeZone?: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return Date.now();
  const [, year, month, day, hour = "00", minute = "00", second = "00", utc] = match;
  if (utc) return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (!timeZone || timeZone === LONDON) return londonTimeMs(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function parseIcsEvents(source: string, eventUrl: string, calendarName: string, etag?: string): ICloudEvent[] {
  const events: ICloudEvent[] = [];
  let fields: Record<string, IcalField> | null = null;
  for (const line of unfoldIcs(source)) {
    if (line.toUpperCase() === "BEGIN:VEVENT") {
      fields = {};
      continue;
    }
    if (line.toUpperCase() === "END:VEVENT") {
      if (fields) {
        const starts = fields.DTSTART;
        const ends = fields.DTEND;
        const allDay = starts?.params.VALUE === "DATE" || Boolean(starts?.value.match(/^\d{8}$/));
        events.push({
          uid: fields.UID?.value ?? "",
          title: unescapeIcs(fields.SUMMARY?.value ?? "(untitled)"),
          start: starts ? (allDay ? calendarDayMs(starts.value) : icalTimeMs(starts.value, starts.params.TZID)) : Date.now(),
          end: ends ? (allDay ? calendarDayMs(ends.value) : icalTimeMs(ends.value, ends.params.TZID)) : undefined,
          allDay,
          location: fields.LOCATION ? unescapeIcs(fields.LOCATION.value) : undefined,
          notes: fields.DESCRIPTION ? unescapeIcs(fields.DESCRIPTION.value) : undefined,
          eventUrl,
          etag,
          calendarName,
          source: "icloud",
        });
      }
      fields = null;
      continue;
    }
    if (!fields) continue;
    const field = icalField(line);
    if (field && ["UID", "SUMMARY", "DTSTART", "DTEND", "LOCATION", "DESCRIPTION"].includes(field.name)) fields[field.name] ??= field;
  }
  return events;
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
        events.push(...parseIcsEvents(data, new URL(resource, calendar.url).toString(), calendar.name, text(property(row, "getetag")) || undefined));
      }
      return events;
    }),
  );
  const events = eventGroups.flat();
  return events.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title));
}

export async function createICloudEvent(input: ICloudEventInput): Promise<ICloudEvent> {
  const calendar = await resolveCalendar(input.calendar);
  const allDay = input.allDay === true;
  const end = input.end ?? input.start + (allDay ? 86_400_000 : 60 * 60_000);
  const uid = `${randomUUID()}@jarvis`;
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
  };
}

function eventUrlIsOwned(url: string, home: string): boolean {
  try {
    const candidate = new URL(url);
    const account = new URL(home);
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
