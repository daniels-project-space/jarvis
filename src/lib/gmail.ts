import "server-only";

import { getGoogleAccessToken } from "./google-oauth";
import { parseIcsVevents, type ParsedIcsEvent } from "./ics";

// Feature 4b: Gmail capability — read / search / draft / unsubscribe / mark
// spam. Built on top of Feature 4a's getGoogleAccessToken() (src/lib/
// google-oauth.ts) for the bearer token, and on the shared ICS parser
// (src/lib/ics.ts, extracted from icloud-calendar.ts) for genuine
// .ics/text-calendar attachment detection.
//
// HARD RULE: this file must never call a Gmail send endpoint. It creates
// drafts only (drafts.create) — never drafts.send, never messages.send.
// gmailUnsubscribe() and gmailModifyLabels()/gmailMarkSpam() perform real,
// irreversible-ish mutations against Daniel's live inbox; this module
// intentionally takes NO "confirmed" parameter for either — the confirmation
// gate belongs in the tool dispatch layer (src/lib/tools.ts), which must
// refuse to call them without an explicit, chat-confirmed yes from Daniel.

export class GmailError extends Error {}

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
type RawGmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
};

export type GmailAttachment = {
  filename: string;
  mimeType: string;
  attachmentId?: string;
  size?: number;
};

export type GmailMessageSummary = {
  id: string;
  threadId?: string;
  subject: string;
  from: string;
  to?: string;
  date?: string;
  internalDate?: number;
  snippet: string;
  hasIcsAttachment: boolean;
  icsEvents?: ParsedIcsEvent[];
};

export type GmailMessageDetail = GmailMessageSummary & {
  bodyText: string;
  attachments: GmailAttachment[];
};

export type SubscriptionCandidate = {
  senderEmail: string;
  senderName?: string;
  count: number;
  latestMessageId: string;
  latestSubject: string;
  latestDate?: string;
  listUnsubscribe: string;
  oneClick: boolean;
};

export type GmailDraftInput = {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyToMessageId?: string;
};

export type GmailDraftResult = { draftId: string; messageId?: string; threadId?: string };

export type UnsubscribeResult =
  | { method: "one-click-post"; target: string }
  | { method: "draft"; draftId: string; to: string }
  | { method: "unavailable"; reason: string };

// Extends booking-email.ts's existing confirmed-booking keyword list (kept
// verbatim below) with broader calendar-relevant terms — appointments,
// invites, RSVPs, deadlines — per the Feature 4b brief: "extend rather than
// replace."
const CALENDAR_RELEVANT_KEYWORDS =
  '("booking confirmation" OR "reservation confirmed" OR "your booking is confirmed" OR "flight confirmation" OR ' +
  '"hotel confirmation" OR "e-ticket" OR appointment OR invite OR invitation OR RSVP OR "save the date" OR ' +
  'deadline OR "due date" OR reminder OR "calendar invite" OR "meeting confirmed" OR "registration confirmed")';
const CALENDAR_RELEVANT_DEFAULT_QUERY = `${CALENDAR_RELEVANT_KEYWORDS} -in:spam -in:trash`;

function buildQuery(params: Record<string, string | string[] | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => usp.append(key, item));
    else usp.append(key, value);
  }
  return usp.toString();
}

async function gmailApi<T = unknown>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const token = await getGoogleAccessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body) headers["content-type"] = "application/json";
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GmailError(`Gmail API ${path} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`);
  }
  return (await response.json()) as T;
}

function headerValue(payload: GmailPart | undefined, name: string): string {
  return String(payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "");
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function flattenParts(part?: GmailPart): GmailPart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(flattenParts)];
}

function findCalendarParts(payload?: GmailPart): GmailPart[] {
  return flattenParts(payload).filter(
    (part) => part.mimeType === "text/calendar" || (part.filename ? /\.ics$/i.test(part.filename) : false),
  );
}

async function calendarPartText(messageId: string, part: GmailPart): Promise<string | null> {
  if (part.body?.data) return decodeBase64Url(part.body.data);
  if (part.body?.attachmentId) {
    const attachment = await gmailApi<{ data?: string }>(
      `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
    );
    return attachment.data ? decodeBase64Url(attachment.data) : null;
  }
  return null;
}

function decodeHtmlEntitiesMinimal(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

function stripHtml(value: string): string {
  return decodeHtmlEntitiesMinimal(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
}

function extractBodyText(part?: GmailPart): string {
  if (!part) return "";
  const raw = part.body?.data ? decodeBase64Url(part.body.data) : "";
  const own = part.mimeType === "text/plain" ? raw : part.mimeType === "text/html" ? stripHtml(raw) : "";
  const nested = (part.parts ?? []).map(extractBodyText).join("\n");
  return `${own}\n${nested}`.trim();
}

/** Parses each candidate message's parts for a genuine text/calendar (or *.ics-named) attachment and extracts real events — far more reliable than keyword matching alone. */
async function summarizeMessage(message: RawGmailMessage): Promise<GmailMessageSummary> {
  const id = String(message.id ?? "");
  const calendarParts = findCalendarParts(message.payload);
  let icsEvents: ParsedIcsEvent[] | undefined;
  if (calendarParts.length) {
    const texts = await Promise.all(calendarParts.map((part) => calendarPartText(id, part)));
    const events = texts.filter((text): text is string => Boolean(text)).flatMap((text) => parseIcsVevents(text));
    if (events.length) icsEvents = events;
  }
  return {
    id,
    threadId: message.threadId,
    subject: headerValue(message.payload, "Subject") || "(no subject)",
    from: headerValue(message.payload, "From"),
    to: headerValue(message.payload, "To") || undefined,
    date: headerValue(message.payload, "Date") || undefined,
    internalDate: message.internalDate ? Number(message.internalDate) : undefined,
    snippet: String(message.snippet ?? ""),
    hasIcsAttachment: calendarParts.length > 0,
    icsEvents,
  };
}

/**
 * Searches Gmail. Pass a caller query (same syntax as the Gmail search box)
 * or omit it to use a default tuned to surface calendar-relevant mail
 * (extends booking-email.ts's confirmed-booking keywords with appointments,
 * invites, RSVPs, deadlines) plus real .ics/text-calendar attachment
 * detection. Read-only.
 */
export async function gmailSearch(query?: string, maxResults = 20): Promise<GmailMessageSummary[]> {
  const capped = Math.max(1, Math.min(50, Math.round(maxResults || 20)));
  const trimmed = String(query ?? "").trim().slice(0, 400);
  const q = trimmed || CALENDAR_RELEVANT_DEFAULT_QUERY;
  const listed = await gmailApi<{ messages?: { id?: string; threadId?: string }[] }>(
    `messages?${buildQuery({ q, maxResults: String(capped) })}`,
  );
  const ids = (listed.messages ?? []).filter((item): item is { id: string; threadId?: string } => Boolean(item.id));
  const raw = await Promise.all(
    ids.map((item) => gmailApi<RawGmailMessage>(`messages/${encodeURIComponent(item.id)}?${buildQuery({ format: "full" })}`)),
  );
  return await Promise.all(raw.map(summarizeMessage));
}

/** Reads one message in full: headers, body text, attachment list, and any parsed calendar-invite events. Read-only. */
export async function gmailReadMessage(messageId: string): Promise<GmailMessageDetail> {
  const id = String(messageId ?? "").trim();
  if (!id) throw new GmailError("gmailReadMessage requires a messageId.");
  const message = await gmailApi<RawGmailMessage>(`messages/${encodeURIComponent(id)}?${buildQuery({ format: "full" })}`);
  const summary = await summarizeMessage(message);
  const bodyText = extractBodyText(message.payload);
  const attachments: GmailAttachment[] = flattenParts(message.payload)
    .filter((part) => part.filename)
    .map((part) => ({
      filename: String(part.filename),
      mimeType: part.mimeType ?? "application/octet-stream",
      attachmentId: part.body?.attachmentId,
      size: part.body?.size,
    }));
  return { ...summary, bodyText, attachments };
}

function safeHeaderText(value: string, label: string): string {
  if (/[\r\n\0]/.test(value)) throw new GmailError(`${label} cannot contain line breaks or control characters.`);
  return value;
}

const MAILBOX = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;

// Drafts are constructed as raw RFC 2822 text. Accept the common, safe forms
// (`person@example.com` and `Name <person@example.com>`) but reject arbitrary
// display/header fragments before they reach the To line.
function normalizeRecipients(input: string): string {
  const raw = safeHeaderText(input, "Recipient").trim();
  if (!raw) throw new GmailError("gmailCreateDraft requires a recipient (to).");
  const recipients = raw.split(",").map((candidate) => candidate.trim()).filter(Boolean);
  if (!recipients.length || recipients.length > 25) throw new GmailError("Recipient list must contain between one and 25 addresses.");
  return recipients.map((candidate) => {
    const named = candidate.match(/^([^<>]{1,120}?)\s*<([^<>\s]+)>$/);
    const name = named?.[1]?.trim();
    const address = (named?.[2] ?? candidate).trim();
    if (!MAILBOX.test(address)) throw new GmailError(`Invalid email recipient: ${candidate.slice(0, 120)}`);
    if (name && /[\r\n\0,;]/.test(name)) throw new GmailError("Recipient display name contains unsupported characters.");
    return name ? `${name} <${address}>` : address;
  }).join(", ");
}

function encodeMimeSubject(subject: string): string {
  const safe = safeHeaderText(subject, "Subject");
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

/**
 * Creates a Gmail DRAFT only — POSTs to users/me/drafts (drafts.create).
 * Never calls drafts.send or messages.send. The draft sits in Daniel's
 * Gmail Drafts folder until he opens Gmail and sends it himself.
 */
export async function gmailCreateDraft(input: GmailDraftInput): Promise<GmailDraftResult> {
  const to = normalizeRecipients(String(input.to ?? ""));
  const subject = safeHeaderText(String(input.subject ?? "").trim(), "Subject");
  const body = String(input.body ?? "");
  if (!body.trim()) throw new GmailError("gmailCreateDraft requires draft body text.");

  let inReplyToHeader: string | undefined;
  let referencesHeader: string | undefined;
  let threadId = input.threadId;
  if (input.inReplyToMessageId) {
    try {
      const original = await gmailApi<RawGmailMessage>(
        `messages/${encodeURIComponent(input.inReplyToMessageId)}?${buildQuery({
          format: "metadata",
          metadataHeaders: ["Message-Id", "Message-ID", "References"],
        })}`,
      );
      const messageIdHeader = headerValue(original.payload, "Message-Id") || headerValue(original.payload, "Message-ID");
      if (messageIdHeader) {
        inReplyToHeader = safeHeaderText(messageIdHeader, "Reply message id");
        const priorReferences = headerValue(original.payload, "References");
        referencesHeader = priorReferences
          ? `${safeHeaderText(priorReferences, "Reply references")} ${inReplyToHeader}`
          : inReplyToHeader;
      }
      threadId = threadId ?? original.threadId;
    } catch {
      // Non-fatal — the draft is still created, just without In-Reply-To threading headers.
    }
  }

  const mime =
    `To: ${to}\r\n` +
    `Subject: ${encodeMimeSubject(subject)}\r\n` +
    (inReplyToHeader ? `In-Reply-To: ${inReplyToHeader}\r\n` : "") +
    (referencesHeader ? `References: ${referencesHeader}\r\n` : "") +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    body;
  const raw = Buffer.from(mime, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const created = await gmailApi<{ id?: string; message?: { id?: string; threadId?: string } }>("drafts", {
    method: "POST",
    body: JSON.stringify({ message: { ...(threadId ? { threadId } : {}), raw } }),
  });
  if (!created.id) throw new GmailError("Gmail did not return a draft id.");
  return { draftId: created.id, messageId: created.message?.id, threadId: created.message?.threadId };
}

/**
 * Scans recent mail for a List-Unsubscribe header (RFC 2369/8058) and groups
 * hits by sender + frequency. Read-only — returns candidates for Jarvis to
 * present to Daniel; does not act on anything.
 */
export async function gmailListLikelySubscriptions(options: { days?: number; maxResults?: number } = {}): Promise<SubscriptionCandidate[]> {
  const days = Math.max(7, Math.min(365, Math.round(options.days ?? 60)));
  const maxResults = Math.max(1, Math.min(150, Math.round(options.maxResults ?? 80)));
  const listed = await gmailApi<{ messages?: { id?: string }[] }>(
    `messages?${buildQuery({ q: `newer_than:${days}d -in:spam -in:trash`, maxResults: String(maxResults) })}`,
  );
  const ids = (listed.messages ?? []).filter((item): item is { id: string } => Boolean(item.id)).map((item) => item.id);
  const rows = await Promise.all(
    ids.map((id) =>
      gmailApi<RawGmailMessage>(
        `messages/${encodeURIComponent(id)}?${buildQuery({
          format: "metadata",
          metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post", "From", "Subject", "Date"],
        })}`,
      ).catch(() => null),
    ),
  );

  const bySender = new Map<string, SubscriptionCandidate>();
  for (const message of rows) {
    if (!message) continue;
    const listUnsubscribe = headerValue(message.payload, "List-Unsubscribe");
    if (!listUnsubscribe) continue;
    const from = headerValue(message.payload, "From");
    const email = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase().trim();
    if (!email) continue;
    const name = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
    const oneClick = /list-unsubscribe=one-click/i.test(headerValue(message.payload, "List-Unsubscribe-Post"));
    const existing = bySender.get(email);
    if (existing) {
      existing.count += 1;
      continue;
    }
    bySender.set(email, {
      senderEmail: email,
      senderName: name && name.toLowerCase() !== email ? name : undefined,
      count: 1,
      latestMessageId: String(message.id ?? ""),
      latestSubject: headerValue(message.payload, "Subject") || "(no subject)",
      latestDate: headerValue(message.payload, "Date") || undefined,
      listUnsubscribe,
      oneClick,
    });
  }
  return [...bySender.values()].sort((a, b) => b.count - a.count);
}

function parseListUnsubscribe(headerVal: string): { https?: string; mailto?: string } {
  const uris = [...headerVal.matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  return {
    https: uris.find((uri) => /^https?:/i.test(uri)),
    mailto: uris.find((uri) => /^mailto:/i.test(uri)),
  };
}

function parseMailto(mailto: string): { to: string; subject?: string; body?: string } {
  try {
    const url = new URL(mailto);
    return {
      to: decodeURIComponent(url.pathname),
      subject: url.searchParams.get("subject") ?? undefined,
      body: url.searchParams.get("body") ?? undefined,
    };
  } catch {
    const [to, query] = mailto.replace(/^mailto:/i, "").split("?");
    const params = new URLSearchParams(query ?? "");
    return { to: decodeURIComponent(to ?? ""), subject: params.get("subject") ?? undefined, body: params.get("body") ?? undefined };
  }
}

/**
 * Unsubscribes from the mailing list behind one message's List-Unsubscribe
 * header: an RFC 8058 one-click POST when the message asserts support for
 * it, otherwise a Gmail DRAFT (via gmailCreateDraft — never auto-sent) to
 * the mailto: fallback address. Takes NO confirmation parameter by design —
 * see the module header comment. Callers (tools.ts) must gate this behind
 * an explicit, chat-confirmed yes from Daniel before calling it.
 */
export async function gmailUnsubscribe(messageId: string): Promise<UnsubscribeResult> {
  const id = String(messageId ?? "").trim();
  if (!id) throw new GmailError("gmailUnsubscribe requires a messageId.");
  const message = await gmailApi<RawGmailMessage>(
    `messages/${encodeURIComponent(id)}?${buildQuery({
      format: "metadata",
      metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post", "From", "Subject"],
    })}`,
  );
  const headerVal = headerValue(message.payload, "List-Unsubscribe");
  if (!headerVal) return { method: "unavailable", reason: "This message has no List-Unsubscribe header — there's no automated way to unsubscribe from it." };

  const { https, mailto } = parseListUnsubscribe(headerVal);
  const oneClickSupported = /List-Unsubscribe=One-Click/i.test(headerValue(message.payload, "List-Unsubscribe-Post"));

  if (https && oneClickSupported) {
    const response = await fetch(https, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { method: "unavailable", reason: `The sender's one-click unsubscribe endpoint returned HTTP ${response.status}.` };
    return { method: "one-click-post", target: https };
  }

  if (mailto) {
    const parsed = parseMailto(mailto);
    if (!parsed.to) return { method: "unavailable", reason: "The List-Unsubscribe mailto link had no address." };
    const draft = await gmailCreateDraft({
      to: parsed.to,
      subject: parsed.subject || "unsubscribe",
      body: parsed.body || "Please unsubscribe me from this mailing list.",
    });
    return { method: "draft", draftId: draft.draftId, to: parsed.to };
  }

  if (https) {
    return { method: "unavailable", reason: `No one-click confirmation header, and no mailto fallback — Daniel should open this link himself to unsubscribe: ${https}` };
  }
  return { method: "unavailable", reason: "The List-Unsubscribe header did not contain a usable https or mailto target." };
}

/**
 * Adds/removes Gmail labels on one message (messages.modify). Takes NO
 * confirmation parameter by design — see the module header comment; the
 * tool dispatch layer must gate this behind an explicit chat confirmation.
 */
export async function gmailModifyLabels(
  messageId: string,
  changes: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ id: string; labelIds: string[] }> {
  const id = String(messageId ?? "").trim();
  if (!id) throw new GmailError("gmailModifyLabels requires a messageId.");
  const addLabelIds = (changes.addLabelIds ?? []).filter(Boolean);
  const removeLabelIds = (changes.removeLabelIds ?? []).filter(Boolean);
  if (!addLabelIds.length && !removeLabelIds.length) throw new GmailError("gmailModifyLabels requires at least one label to add or remove.");
  const result = await gmailApi<{ id?: string; labelIds?: string[] }>(`messages/${encodeURIComponent(id)}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  return { id: String(result.id ?? id), labelIds: result.labelIds ?? [] };
}

/** Marks one message as spam (adds SPAM, removes INBOX). No confirmation param by design — see module header comment. */
export async function gmailMarkSpam(messageId: string): Promise<{ id: string; labelIds: string[] }> {
  return await gmailModifyLabels(messageId, { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
}
