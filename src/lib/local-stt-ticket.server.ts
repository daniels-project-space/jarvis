import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TICKET_VERSION = 1;
const MAX_TICKET_AGE_MS = 60_000;

export type LocalSttTicketPayload = {
  v: typeof TICKET_VERSION;
  aud: "jarvis-final-stt";
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

/** Mint a one-use browser upload capability without exposing the host secret. */
export function createLocalSttTicket(args: {
  secret: string;
  origin: string;
  now?: number;
}): { ticket: string; expiresAt: number } {
  const secret = args.secret.trim();
  const origin = validOrigin(args.origin);
  if (!secret || !origin) throw new Error("local speech recognition is not configured safely");
  const now = args.now ?? Date.now();
  const payload: LocalSttTicketPayload = {
    v: TICKET_VERSION,
    aud: "jarvis-final-stt",
    exp: now + MAX_TICKET_AGE_MS,
    nonce: randomBytes(18).toString("base64url"),
    origin,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { ticket: `${encoded}.${signature(encoded, secret).toString("base64url")}`, expiresAt: payload.exp };
}

/** Test parser kept in lockstep with the separate Python recognizer. */
export function verifyLocalSttTicket(args: {
  ticket: string;
  secret: string;
  now?: number;
}): LocalSttTicketPayload | null {
  const parts = args.ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !args.secret) return null;
  const supplied = Buffer.from(parts[1], "base64url");
  const expected = signature(parts[0], args.secret);
  if (!supplied.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const decoded = Buffer.from(parts[0], "base64url");
    if (!decoded.length || decoded.toString("base64url") !== parts[0]) return null;
    const value = JSON.parse(decoded.toString("utf8")) as Partial<LocalSttTicketPayload>;
    if (
      value.v !== TICKET_VERSION
      || value.aud !== "jarvis-final-stt"
      || typeof value.exp !== "number"
      || !Number.isSafeInteger(value.exp)
      || value.exp <= (args.now ?? Date.now())
      || typeof value.nonce !== "string"
      || !/^[A-Za-z0-9_-]{20,}$/.test(value.nonce)
      || typeof value.origin !== "string"
      || validOrigin(value.origin) !== value.origin
    ) return null;
    return value as LocalSttTicketPayload;
  } catch {
    return null;
  }
}
