import "server-only";

import { createHash } from "node:crypto";
import { getGoogleAccessToken } from "./google-oauth";

export type BookingKind = "flight" | "stay" | "activity" | "transport" | "dining" | "reservation";

export type ConfirmedBooking = {
  id: string;
  threadId?: string;
  kind: BookingKind;
  title: string;
  provider: string;
  start?: number;
  end?: number;
  allDay: boolean;
  confirmationCode?: string;
  bookingName?: string;
  location?: string;
  timeZone?: string;
  sourceUrl?: string;
  marker: string;
};

export class GmailBookingsError extends Error {}

type GmailHeader = { name?: string; value?: string };
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id?: string; threadId?: string; internalDate?: string; snippet?: string; payload?: { headers?: GmailHeader[]; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] } };
type JsonObject = Record<string, unknown>;

const DAY = 86_400_000;
const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

function clean(value: unknown, limit = 240): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function readableBody(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => clean(line, 500))
    .filter(Boolean)
    .join("\n")
    .slice(0, 40_000);
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function jsonLdObjects(value: string): JsonObject[] {
  const roots: unknown[] = [];
  for (const match of value.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      roots.push(JSON.parse(decodeHtmlEntities(match[1]).trim()));
    } catch {
      // Malformed structured data must not prevent the plain-text fallback.
    }
  }
  const objects: JsonObject[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const value = node as JsonObject;
    objects.push(value);
    Object.values(value).forEach(visit);
  };
  roots.forEach(visit);
  return objects;
}

function structuredBooking(value: string): JsonObject | undefined {
  const rows = jsonLdObjects(value);
  return rows.find((row) => /reservation/i.test([row["@type"]].flat().join(" ")))
    ?? rows.find((row) => row.checkinTime || row.checkInTime || row.checkoutTime || row.checkOutTime);
}

function structuredAddress(value: unknown): string | undefined {
  if (typeof value === "string") return clean(value, 240) || undefined;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const country = typeof row.addressCountry === "object"
    ? (row.addressCountry as Record<string, unknown>).name
    : row.addressCountry;
  const parts = [row.streetAddress, row.postalCode, row.addressLocality, row.addressRegion, country]
    .map((part) => clean(String(part ?? ""), 100))
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(", ").slice(0, 240) : undefined;
}

function validTimeZone(value: unknown): string | undefined {
  const zone = clean(String(value ?? ""), 80);
  if (!/^[A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+$/.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return undefined;
  }
}

function timeZoneFrom(text: string, structured?: JsonObject): string | undefined {
  const reservationFor = jsonObject(structured?.reservationFor);
  const direct = structured?.timeZone ?? structured?.timezone ?? reservationFor?.timeZone;
  return validTimeZone(direct)
    ?? validTimeZone(/(?:time\s*zone|timezone)\s*:?\s*([A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+)/i.exec(text)?.[1]);
}

function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number | undefined {
  const utc = toEpoch(year, month, day, hour, minute);
  if (!utc || !timeZone) return utc;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    let candidate = utc;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
      const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
      candidate -= rendered - utc;
    }
    return candidate;
  } catch {
    return utc;
  }
}

function header(message: GmailMessage, name: string): string {
  return String(message.payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "");
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function messageBody(part: GmailPart | undefined): string {
  if (!part) return "";
  const own = part.mimeType === "text/plain" || part.mimeType === "text/html" ? decodeBase64Url(String(part.body?.data ?? "")) : "";
  const nested = (part.parts ?? []).map(messageBody).join("\n");
  return `${own}\n${nested}`;
}

function toEpoch(year: number, month: number, day: number, hour = 0, minute = 0): number | undefined {
  const date = new Date(Date.UTC(year, month, day, hour, minute));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date.getTime() : undefined;
}

function firstDate(text: string, fallbackYear: number): { value: number; end: number } | null {
  const iso = /\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.]([0-3]?\d)\b/.exec(text);
  if (iso) {
    const value = toEpoch(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (value) return { value, end: iso.index + iso[0].length };
  }
  const written = /\b(?:(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?),?\s*)?([0-3]?\d)(?:st|nd|rd|th)?\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\w*\s*(20\d{2})?\b/i.exec(text);
  if (written) {
    const value = toEpoch(Number(written[3] ?? fallbackYear), MONTHS[written[2].toLowerCase()], Number(written[1]));
    if (value) return { value, end: written.index + written[0].length };
  }
  const monthFirst = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\w*\s+([0-3]?\d)(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/i.exec(text);
  if (!monthFirst) return null;
  const value = toEpoch(Number(monthFirst[3] ?? fallbackYear), MONTHS[monthFirst[1].toLowerCase()], Number(monthFirst[2]));
  return value ? { value, end: monthFirst.index + monthFirst[0].length } : null;
}

function firstTime(text: string): { hour: number; minute: number } | null {
  const match = /\b([0-1]?\d|2[0-3]):([0-5]\d)\b|\b(1[0-2]|0?[1-9])(?:\.([0-5]\d))?\s*(am|pm)\b/i.exec(text);
  if (!match) return null;
  if (match[1]) return { hour: Number(match[1]), minute: Number(match[2]) };
  let hour = Number(match[3]);
  if (match[5].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[5].toLowerCase() === "am" && hour === 12) hour = 0;
  return { hour, minute: Number(match[4] ?? 0) };
}

function providerFrom(from: string, subject: string): string {
  const email = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const domain = /@([a-z0-9-]+)(?:\.[a-z0-9.-]+)?/i.exec(email)?.[1];
  if (domain && !/gmail|googlemail|noreply|mail/.test(domain)) return domain.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return clean(subject.split(/[|:—–-]/)[0] || "Booking", 70);
}

function classification(text: string): BookingKind | null {
  if (/\b(cancelled|canceled|refund|declined|pending payment|payment failed)\b/i.test(text)) return null;
  if (!/\b(confirm(?:ed|ation)|reservation|booking|e-?ticket|itinerary|check[- ]?in)\b/i.test(text)) return null;
  if (/\b(flight|airline|boarding|departure|arrival|pnr|e-?ticket)\b/i.test(text)) return "flight";
  if (/\b(hotel|accommodation|room|check[- ]?in|check[- ]?out|nights?)\b|lodging/i.test(text)) return "stay";
  if (/\b(train|rail|coach|ferry|car hire|rental car|transfer)\b/i.test(text)) return "transport";
  if (/\b(restaurant|table for|dinner reservation)\b/i.test(text)) return "dining";
  if (/\b(ticket|tour|museum|attraction|experience|activity|admission)\b/i.test(text)) return "activity";
  return "reservation";
}

function confirmationCode(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:booking\s+(?:reference|number|no\.?|code)|reservation\s+(?:number|no\.?|code)|confirmation\s+(?:number|no\.?|code)|reference|ref|pnr)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,18})\b/gi)];
  return matches.at(-1)?.[1]?.toUpperCase();
}

function labelledDateTime(
  text: string,
  label: RegExp,
  fallbackYear: number,
  timeZone?: string,
): { value: number; hasTime: boolean } | undefined {
  const match = label.exec(text);
  if (!match) return undefined;
  const segment = text.slice(match.index + match[0].length, match.index + match[0].length + 220);
  const date = firstDate(segment, fallbackYear);
  if (!date) return undefined;
  const time = firstTime(segment.slice(0, date.end + 80));
  const parsed = new Date(date.value);
  const value = zonedEpoch(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), time?.hour ?? 0, time?.minute ?? 0, timeZone);
  return value ? { value, hasTime: Boolean(time) } : undefined;
}

function structuredDate(value: unknown, timeZone?: string): { value: number; hasTime: boolean } | undefined {
  const input = clean(String(value ?? ""), 120);
  if (!input) return undefined;
  const hasTime = /T\d{1,2}:\d{2}/.test(input);
  if (hasTime && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
    const parsed = Date.parse(input);
    return Number.isFinite(parsed) ? { value: parsed, hasTime: true } : undefined;
  }
  const date = firstDate(input, new Date().getUTCFullYear());
  if (!date) return undefined;
  const time = firstTime(input);
  const parsed = new Date(date.value);
  const epoch = zonedEpoch(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), time?.hour ?? 0, time?.minute ?? 0, timeZone);
  return epoch ? { value: epoch, hasTime: Boolean(time) } : undefined;
}

function addressFromLines(text: string): string | undefined {
  const lines = text.split("\n").map((line) => clean(line, 260)).filter(Boolean);
  const index = lines.findIndex((line) => /^(?:property\s+)?address\b|^location\b/i.test(line));
  if (index < 0) return undefined;
  const inline = clean(lines[index].replace(/^(?:(?:property\s+)?address|location)\s*:?\s*/i, ""), 240);
  if (inline) return inline;
  const parts: string[] = [];
  for (const line of lines.slice(index + 1, index + 5)) {
    if (/^(?:check[- ]?in|check[- ]?out|confirmation|booking|reservation|telephone|phone|contact)\b/i.test(line)) break;
    parts.push(line);
  }
  return parts.length ? parts.join(", ").slice(0, 240) : undefined;
}

function bookingNameFrom(subject: string, text: string, structured?: JsonObject): string | undefined {
  const reservationFor = structured?.reservationFor;
  const structuredName = clean(typeof reservationFor === "string" ? reservationFor : jsonObject(reservationFor)?.name, 120);
  if (structuredName) return structuredName;
  const labelled = /^(?:property|hotel|accommodation|venue|experience|restaurant)(?:\s+name)?\s*:\s*(.+)$/im.exec(text)?.[1];
  if (labelled) return clean(labelled, 120);
  const subjectName = /(?:booking|reservation)(?:\s+at)?\s*[:\-–—]\s*(.+?)(?:\s+(?:is\s+)?confirmed)?$/i.exec(subject)?.[1]
    ?? /(?:booking|reservation)\s+at\s+(.+?)(?:\s+(?:is\s+)?confirmed)?$/i.exec(subject)?.[1];
  return clean(subjectName ?? "", 120) || undefined;
}

export function parseBookingEmail(input: { id: string; threadId?: string; subject: string; from: string; body: string; sentAt?: number }): ConfirmedBooking | null {
  const structured = structuredBooking(input.body);
  const reservationFor = jsonObject(structured?.reservationFor);
  const readable = readableBody(input.body);
  const source = clean(`${input.subject}\n${readable}\n${structured ? JSON.stringify(structured) : ""}`, 40_000);
  const kind = classification(source);
  if (!kind) return null;
  const fallbackYear = new Date(input.sentAt ?? Date.now()).getUTCFullYear();
  const timeZone = timeZoneFrom(readable, structured);
  const checkIn = structuredDate(structured?.checkinTime ?? structured?.checkInTime ?? structured?.checkinDate ?? structured?.checkInDate, timeZone)
    ?? labelledDateTime(readable, /\bcheck[- ]?in(?:\s+(?:date|time))?\s*:?/i, fallbackYear, timeZone);
  const checkOut = structuredDate(structured?.checkoutTime ?? structured?.checkOutTime ?? structured?.checkoutDate ?? structured?.checkOutDate, timeZone)
    ?? labelledDateTime(readable, /\bcheck[- ]?out(?:\s+(?:date|time))?\s*:?/i, fallbackYear, timeZone);
  const date = checkIn ? undefined : firstDate(source, fallbackYear);
  const time = checkIn ? undefined : firstTime(source.slice(0, date ? date.end + 500 : 4_000));
  const genericStart = date
    ? zonedEpoch(new Date(date.value).getUTCFullYear(), new Date(date.value).getUTCMonth(), new Date(date.value).getUTCDate(), time?.hour ?? 0, time?.minute ?? 0, timeZone)
    : undefined;
  const start = checkIn?.value ?? structuredDate(reservationFor?.departureTime ?? structured?.departureTime, timeZone)?.value ?? genericStart;
  const provider = providerFrom(input.from, input.subject);
  const reference = clean(String(structured?.reservationNumber ?? structured?.confirmationNumber ?? ""), 24).toUpperCase() || confirmationCode(source);
  const bookingName = bookingNameFrom(input.subject, readable, structured);
  const location = structuredAddress(reservationFor?.address ?? structured?.address) ?? addressFromLines(readable);
  const icon = kind === "flight" ? "✈" : kind === "stay" ? "🏨" : kind === "activity" ? "🎟" : kind === "transport" ? "🚆" : kind === "dining" ? "🍽" : "📌";
  const allDay = Boolean(start && !(checkIn?.hasTime ?? Boolean(time)));
  return {
    id: input.id,
    threadId: input.threadId,
    kind,
    title: `${icon} ${bookingName ?? provider} · confirmed`,
    provider,
    start,
    end: checkOut?.value ?? (start && allDay ? start + DAY : start ? start + (kind === "flight" ? 3 * 60 * 60_000 : 60 * 60_000) : undefined),
    allDay,
    confirmationCode: reference,
    bookingName,
    location,
    timeZone,
    sourceUrl: `https://mail.google.com/mail/u/0/#all/${input.id}`,
    marker: `jarvis-gmail-booking:${input.id}`,
  };
}

async function accessToken(): Promise<string> {
  // Feature 4b: delegates to the shared Feature 4a helper, which reads the
  // Convex-stored encrypted Google connection first and transparently falls
  // back to these same legacy GMAIL_BOOKINGS_CLIENT_ID/CLIENT_SECRET/
  // REFRESH_TOKEN env vars internally if no Convex connection exists yet —
  // see src/lib/google-oauth.ts. Its own token cache replaces the one that
  // used to live here.
  return await getGoogleAccessToken();
}

async function gmail<T = JsonObject>(path: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new GmailBookingsError(`Gmail booking sync returned HTTP ${response.status}.`);
  return await response.json() as T;
}

export async function scanGmailBookingConfirmations(options: { days?: number; maxResults?: number; search?: string } = {}): Promise<ConfirmedBooking[]> {
  const days = Math.max(7, Math.min(730, Math.round(options.days ?? 365)));
  const maxResults = Math.max(1, Math.min(80, Math.round(options.maxResults ?? 40)));
  const search = clean(String(options.search ?? ""), 120).replace(/["{}()]/g, " ").trim();
  const query = `newer_than:${days}d -in:spam -in:trash ("booking confirmation" OR "reservation confirmed" OR "your booking is confirmed" OR "flight confirmation" OR "hotel confirmation" OR "e-ticket")${search ? ` "${search}"` : ""}`;
  const listed = await gmail<{ messages?: { id?: string }[] }>(`messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
  const rows = await Promise.all((Array.isArray(listed.messages) ? listed.messages : []).map((row) => row.id ? gmail<GmailMessage>(`messages/${encodeURIComponent(row.id)}?format=full`) : null));
  const bookings = rows
    .filter((message): message is GmailMessage => Boolean(message))
    .map((message) => parseBookingEmail({
      id: String(message.id), threadId: message.threadId, subject: header(message, "subject"), from: header(message, "from"),
      body: messageBody(message.payload) || String(message.snippet ?? ""), sentAt: Number(message.internalDate ?? Date.now()),
    }))
    .filter((booking): booking is ConfirmedBooking => Boolean(booking));
  const seen = new Set<string>();
  return bookings.filter((booking) => {
    const key = `${booking.kind}:${booking.confirmationCode ?? createHash("sha256").update(`${booking.provider}:${booking.start ?? ""}:${booking.id}`).digest("hex")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER));
}

/** Explicit read-only entry point for proactive travel lookup. It performs no calendar or trip writes. */
export async function lookupGmailBookingsReadOnly(options: { days?: number; maxResults?: number; search?: string } = {}): Promise<ConfirmedBooking[]> {
  return await scanGmailBookingConfirmations({
    days: options.days,
    maxResults: options.maxResults ?? 20,
    search: options.search,
  });
}
