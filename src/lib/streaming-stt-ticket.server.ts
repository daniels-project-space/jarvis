import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TICKET_VERSION = 1;
const MAX_TICKET_AGE_MS = 60_000;

export type StreamingSttTicketPayload = {
  v: typeof TICKET_VERSION;
  aud: "jarvis-streaming-stt";
  exp: number;
  nonce: string;
  origin: string;
};

function validOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function signature(encoded: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

/** Creates a short-lived, single-use ticket for the separate CPU ASR host. */
export function createStreamingSttTicket(args: {
  secret: string;
  origin: string;
  now?: number;
}): { ticket: string; expiresAt: number } {
  const secret = args.secret.trim();
  const origin = validOrigin(args.origin);
  if (!secret || !origin) throw new Error("streaming speech is not configured safely");
  const now = args.now ?? Date.now();
  const payload: StreamingSttTicketPayload = {
    v: TICKET_VERSION,
    aud: "jarvis-streaming-stt",
    exp: now + MAX_TICKET_AGE_MS,
    nonce: randomBytes(18).toString("base64url"),
    origin,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { ticket: `${encoded}.${signature(encoded, secret).toString("base64url")}`, expiresAt: payload.exp };
}

/** Testable parser used to keep the browser-ticket format constrained. */
export function verifyStreamingSttTicket(args: {
  ticket: string;
  secret: string;
  now?: number;
}): StreamingSttTicketPayload | null {
  const parts = args.ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !args.secret) return null;
  const supplied = Buffer.from(parts[1], "base64url");
  const expected = signature(parts[0], args.secret);
  if (!supplied.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const decoded = Buffer.from(parts[0], "base64url");
    if (!decoded.length || decoded.toString("base64url") !== parts[0]) return null;
    const value = JSON.parse(decoded.toString("utf8")) as Partial<StreamingSttTicketPayload>;
    if (
      value.v !== TICKET_VERSION
      || value.aud !== "jarvis-streaming-stt"
      || typeof value.exp !== "number"
      || !Number.isSafeInteger(value.exp)
      || value.exp <= (args.now ?? Date.now())
      || typeof value.nonce !== "string"
      || !/^[A-Za-z0-9_-]{20,}$/.test(value.nonce)
      || typeof value.origin !== "string"
      || validOrigin(value.origin) !== value.origin
    ) return null;
    return value as StreamingSttTicketPayload;
  } catch {
    return null;
  }
}
