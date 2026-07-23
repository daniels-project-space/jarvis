import "server-only";

import { createHash } from "node:crypto";

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
  location?: string;
  sourceUrl?: string;
  marker: string;
};

export class GmailBookingsError extends Error {}

type GmailHeader = { name?: string; value?: string };
type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id?: string; threadId?: string; internalDate?: string; snippet?: string; payload?: { headers?: GmailHeader[]; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] } };

const DAY = 86_400_000;
const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

function clean(value: string, limit = 240): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
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
  if (!written) return null;
  const value = toEpoch(Number(written[3] ?? fallbackYear), MONTHS[written[2].toLowerCase()], Number(written[1]));
  return value ? { value, end: written.index + written[0].length } : null;
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
  if (/\b(hotel|accommodation|room|check[- ]?in|check[- ]?out|nights?)\b/i.test(text)) return "stay";
  if (/\b(train|rail|coach|ferry|car hire|rental car|transfer)\b/i.test(text)) return "transport";
  if (/\b(restaurant|table for|dinner reservation)\b/i.test(text)) return "dining";
  if (/\b(ticket|tour|museum|attraction|experience|activity|admission)\b/i.test(text)) return "activity";
  return "reservation";
}

function confirmationCode(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:booking\s+(?:reference|number|no\.?|code)|reservation\s+(?:number|no\.?|code)|confirmation\s+(?:number|no\.?|code)|reference|ref|pnr)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,18})\b/gi)];
  return matches.at(-1)?.[1]?.toUpperCase();
}

export function parseBookingEmail(input: { id: string; threadId?: string; subject: string; from: string; body: string; sentAt?: number }): ConfirmedBooking | null {
  const source = clean(`${input.subject}\n${input.body}`, 40_000);
  const kind = classification(source);
  if (!kind) return null;
  const date = firstDate(source, new Date(input.sentAt ?? Date.now()).getUTCFullYear());
  const time = firstTime(source.slice(0, date ? date.end + 500 : 4_000));
  const start = date ? toEpoch(new Date(date.value).getUTCFullYear(), new Date(date.value).getUTCMonth(), new Date(date.value).getUTCDate(), time?.hour ?? 0, time?.minute ?? 0) : undefined;
  const provider = providerFrom(input.from, input.subject);
  const reference = confirmationCode(source);
  const icon = kind === "flight" ? "✈" : kind === "stay" ? "🏨" : kind === "activity" ? "🎟" : kind === "transport" ? "🚆" : kind === "dining" ? "🍽" : "📌";
  return {
    id: input.id,
    threadId: input.threadId,
    kind,
    title: `${icon} ${provider} · confirmed`,
    provider,
    start,
    end: start && !time ? start + DAY : start ? start + (kind === "flight" ? 3 * 60 * 60_000 : 60 * 60_000) : undefined,
    allDay: Boolean(start && !time),
    confirmationCode: reference,
    sourceUrl: `https://mail.google.com/mail/u/0/#all/${input.id}`,
    marker: `jarvis-gmail-booking:${input.id}`,
  };
}

let tokenCache: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value;
  const direct = process.env.GMAIL_BOOKINGS_ACCESS_TOKEN;
  if (direct) return direct;
  const clientId = process.env.GMAIL_BOOKINGS_CLIENT_ID;
  const clientSecret = process.env.GMAIL_BOOKINGS_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_BOOKINGS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken)
    throw new GmailBookingsError("Gmail booking sync is not connected yet. Add the read-only Gmail OAuth credentials in the cloud secret store.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    cache: "no-store",
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new GmailBookingsError("Gmail booking sync could not refresh its read-only access.");
  tokenCache = { value: String(payload.access_token), expiresAt: Date.now() + Math.max(60, Number(payload.expires_in ?? 300) - 45) * 1000 };
  return tokenCache.value;
}

async function gmail(path: string): Promise<any> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new GmailBookingsError(`Gmail booking sync returned HTTP ${response.status}.`);
  return await response.json();
}

export async function scanGmailBookingConfirmations(options: { days?: number; maxResults?: number } = {}): Promise<ConfirmedBooking[]> {
  const days = Math.max(7, Math.min(730, Math.round(options.days ?? 365)));
  const maxResults = Math.max(1, Math.min(80, Math.round(options.maxResults ?? 40)));
  const query = `newer_than:${days}d -in:spam -in:trash ("booking confirmation" OR "reservation confirmed" OR "your booking is confirmed" OR "flight confirmation" OR "hotel confirmation" OR "e-ticket")`;
  const listed = await gmail(`messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
  const rows = await Promise.all((Array.isArray(listed.messages) ? listed.messages : []).map((row: { id?: string }) => row.id ? gmail(`messages/${encodeURIComponent(row.id)}?format=full`) : null));
  const bookings = rows
    .filter(Boolean)
    .map((message: GmailMessage) => parseBookingEmail({
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
