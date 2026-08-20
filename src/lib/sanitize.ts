// The live model occasionally writes tool syntax or raw tool JSON as TEXT
// instead of calling the function — then reads it aloud, and the garbage
// poisons mirrored history so the next session imitates it. These helpers
// recover the intended call and keep the junk out of history, chat and speech.

import { GMAIL_SEND_APPROVAL_MARKER } from "./gmail-send-approval-marker";

export type RecoveredCall = { name: string; args: any };

// Matches the observed hallucination shapes:
//   <function>show{"kind":"url","value":"…"}</function>
//   <function>timer{"minutes":2,"label":"Timer"}></function>
const FN_RE = /<function>?\s*(\w+)\s*(\{[\s\S]*?\})?\s*>?\s*<\/function>/gi;
export const GOOGLE_CALENDAR_APPROVAL_MARKER = "JARVIS_GOOGLE_CALENDAR_APPROVAL";
const CALENDAR_APPROVAL_TOKEN_RE = new RegExp(
  `\\[${GOOGLE_CALENDAR_APPROVAL_MARKER}:([A-Za-z0-9_-]{20,4096}\\.[A-Za-z0-9_-]{20,128})\\]`,
);
const CALENDAR_APPROVAL_MARKER_RE = new RegExp(
  `\\s*\\[${GOOGLE_CALENDAR_APPROVAL_MARKER}:[A-Za-z0-9_-]{20,4096}\\.[A-Za-z0-9_-]{20,128}\\]\\s*`,
  "g",
);
const GMAIL_SEND_APPROVAL_TOKEN_RE = new RegExp(
  `\\[${GMAIL_SEND_APPROVAL_MARKER}:([A-Za-z0-9_-]{20,2004}\\.[A-Za-z0-9_-]{43})\\]`,
);
const GMAIL_SEND_APPROVAL_MARKER_RE = new RegExp(
  `\\s*\\[${GMAIL_SEND_APPROVAL_MARKER}:[A-Za-z0-9_-]{20,2004}\\.[A-Za-z0-9_-]{43}\\]\\s*`,
  "g",
);

export function extractFunctionCalls(text: string): RecoveredCall[] {
  const calls: RecoveredCall[] = [];
  for (const m of text.matchAll(FN_RE)) {
    let args: any = {};
    try {
      args = m[2] ? JSON.parse(m[2]) : {};
    } catch {
      continue; // unparseable args — don't guess
    }
    calls.push({ name: m[1], args });
  }
  return calls;
}

export function sanitizeAssistantText(text: string): string {
  let t = text;
  t = t.replace(FN_RE, " ");
  t = t.replace(/<function>[\s\S]*$/gi, " "); // unterminated tool syntax tail
  t = t.replace(/\{"kind"\s*:[\s\S]*$/g, " "); // raw widget JSON blob to end (before the bracket line, or it leaves "}]" residue)
  t = t.replace(/[\w".,:[\]{}\-]*"(?:days|hours|items)"\s*:\s*\[[\s\S]*$/g, " "); // JSON tails
  t = t.replace(/\[showed on screen:[\s\S]*?(\]|$)/gi, " "); // parroted history lines
  t = stripAssistantApprovals(t);
  return t.replace(/[ \t]{2,}/g, " ").trim(); // spaces only — newlines survive
}

/** The token is rendered as a dedicated owner-only button, never chat text. */
export function extractGoogleCalendarApproval(text: string): string | null {
  return text.match(CALENDAR_APPROVAL_TOKEN_RE)?.[1] ?? null;
}

export function stripGoogleCalendarApproval(text: string): string {
  return text.replace(CALENDAR_APPROVAL_MARKER_RE, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The token is rendered as a dedicated owner-only send button, never chat text. */
export function extractGmailSendApproval(text: string): string | null {
  return text.match(GMAIL_SEND_APPROVAL_TOKEN_RE)?.[1] ?? null;
}

export function stripGmailSendApproval(text: string): string {
  return text.replace(GMAIL_SEND_APPROVAL_MARKER_RE, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Remove every opaque, owner-click approval receipt from visible/speech text. */
export function stripAssistantApprovals(text: string): string {
  return stripGmailSendApproval(stripGoogleCalendarApproval(text));
}

// True when the row is pure tool-garbage a human should never see.
export function isToolGarbage(text: string): boolean {
  return /<function|\{"kind"\s*:|\[showed on screen:|"(?:days|hours|items)"\s*:\s*\[/i.test(text);
}
