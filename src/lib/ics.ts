import "server-only";

import ICAL from "ical.js";

// Shared ICS/VEVENT parsing primitives.
//
// This logic originally lived only in icloud-calendar.ts (private, unexported
// helpers). Extracted here — verbatim, not rewritten — so src/lib/gmail.ts
// (Feature 4b) can reuse the exact same VEVENT-walking logic for
// .ics/text/calendar Gmail attachments instead of a second, drifting
// implementation. icloud-calendar.ts keeps everything iCloud/CalDAV-specific
// (eventUrl/etag/calendarName wrapping, PUT/DELETE, calendar resolution) and
// now calls parseIcsVevents() below instead of parsing VEVENTs itself.

const LONDON = "Europe/London";

export type IcalField = { name: string; value: string; params: Record<string, string> };

export type ParsedIcsEvent = {
  uid: string;
  title: string;
  start: number;
  end?: number;
  allDay: boolean;
  location?: string;
  notes?: string;
};

export function unfoldIcs(source: string): string[] {
  const lines: string[] = [];
  for (const raw of source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

export function icalField(line: string): IcalField | null {
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

export function unescapeIcs(value: string): string {
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

export function calendarDayMs(value: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return Date.now();
  return londonTimeMs(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0);
}

export function icalTimeMs(value: string, timeZone?: string): number {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/);
  if (!match) return Date.now();
  const [, year, month, day, hour = "00", minute = "00", second = "00", utc] = match;
  if (utc) return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (!timeZone || timeZone === LONDON) return londonTimeMs(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

/**
 * Walks every VEVENT block in a raw .ics/text-calendar payload and returns a
 * flat, source-agnostic event list. Both icloud-calendar.ts (CalDAV) and
 * gmail.ts (calendar-invite attachments) call this so the VEVENT-walking
 * logic lives in exactly one place.
 */
export function parseIcsVevents(source: string): ParsedIcsEvent[] {
  const events: ParsedIcsEvent[] = [];
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

const MAX_RECURRENCE_ITERATIONS = 100_000;

function intersectsRange(event: ParsedIcsEvent, rangeStart: number, rangeEnd: number): boolean {
  const effectiveEnd = Math.max(event.start + 1, event.end ?? event.start + 1);
  return effectiveEnd > rangeStart && event.start < rangeEnd;
}

/**
 * Expands a CalDAV resource into only the concrete occurrences intersecting a
 * requested time range. CalDAV may return a recurring master whose DTSTART is
 * years outside the REPORT window; returning that master directly produces a
 * stale card instead of the occurrence the server matched.
 *
 * ICAL.js handles RRULE, RDATE, EXDATE, recurrence exceptions, and embedded
 * VTIMEZONE definitions. The bounded iterator prevents a malformed, extremely
 * old high-frequency rule from monopolising a foreground Calendar request.
 */
export function parseIcsOccurrences(source: string, rangeStart: number, rangeEnd: number): ParsedIcsEvent[] {
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) return [];

  const calendar = new ICAL.Component(ICAL.parse(source));
  const components = calendar.name === "vevent" ? [calendar] : calendar.getAllSubcomponents("vevent");
  const occurrences: ParsedIcsEvent[] = [];

  for (const component of components) {
    if (component.hasProperty("recurrence-id")) continue;
    const event = new ICAL.Event(component, { strictExceptions: true });
    const iterator = event.iterator();
    let iterations = 0;
    for (let next = iterator.next(); next; next = iterator.next()) {
      iterations += 1;
      if (iterations > MAX_RECURRENCE_ITERATIONS) {
        throw new Error("iCloud recurrence expansion exceeded its safety limit.");
      }

      const details = event.getOccurrenceDetails(next);
      const item = details.item;
      const reachedRangeEnd = next.toJSDate().getTime() >= rangeEnd;
      const status = item.component.getFirstPropertyValue("status");
      if (typeof status === "string" && status.toUpperCase() === "CANCELLED") {
        if (reachedRangeEnd) break;
        continue;
      }

      const occurrence: ParsedIcsEvent = {
        uid: item.uid ?? event.uid ?? "",
        title: item.summary || "(untitled)",
        start: details.startDate.toJSDate().getTime(),
        end: details.endDate.toJSDate().getTime(),
        allDay: details.startDate.isDate,
        location: item.location || undefined,
        notes: item.description || undefined,
      };
      if (intersectsRange(occurrence, rangeStart, rangeEnd)) occurrences.push(occurrence);

      // Recurrence IDs are ordered. Exceptions whose original recurrence ID
      // lies inside the query are resolved above via getOccurrenceDetails().
      if (reachedRangeEnd) break;
      if (!event.isRecurring()) break;
    }
  }

  return occurrences.sort((left, right) => left.start - right.start || left.title.localeCompare(right.title));
}
