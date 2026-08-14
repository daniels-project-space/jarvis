import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const RECEIPT_VERSION = 1 as const;
const RECEIPT_PREFIX = "fot1";
const RECEIPT_KIND = "jarvis.foreground-owner-tool" as const;
const RECEIPT_TTL_MS = 150_000;
const RECEIPT_MAX_CHARS = 1_800;
const HEX_64 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,256}$/;

export type ForegroundOwnerToolTurn = Readonly<{
  messageId: string;
  assistantId: string;
  claimToken: string;
}>;

export type ForegroundOwnerToolReceiptOperation = "discover" | "invoke";

export type ForegroundOwnerToolReceiptPayload = Readonly<{
  v: typeof RECEIPT_VERSION;
  kind: typeof RECEIPT_KIND;
  messageId: string;
  assistantId: string;
  claimToken: string;
  callId: string;
  operation: ForegroundOwnerToolReceiptOperation;
  target: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type IssueForegroundOwnerToolReceiptInput = Readonly<{
  secret: string;
  turn: ForegroundOwnerToolTurn;
  callId: string;
  operation: ForegroundOwnerToolReceiptOperation;
  target: string;
  now?: number;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function receiptKey(secret: string): Buffer {
  const source = Buffer.from(secret, "utf8");
  if (source.byteLength < 32) throw new Error("foreground owner tool receipt authority is not configured");
  return createHash("sha256")
    .update("jarvis/foreground-owner-tool/receipt-key/v1\0")
    .update(source)
    .digest();
}

function signature(encodedPayload: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update("jarvis/foreground-owner-tool/receipt/v1\0")
    .update(encodedPayload)
    .digest("hex");
}

function safeHexEqual(actual: string, wanted: string): boolean {
  if (!HEX_64.test(actual) || !HEX_64.test(wanted)) return false;
  const actualBytes = Buffer.from(actual, "hex");
  const wantedBytes = Buffer.from(wanted, "hex");
  return actualBytes.length === wantedBytes.length && timingSafeEqual(actualBytes, wantedBytes);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validPayload(value: unknown, now: number): value is ForegroundOwnerToolReceiptPayload {
  if (!record(value) || !exactKeys(value, [
    "v", "kind", "messageId", "assistantId", "claimToken", "callId",
    "operation", "target", "issuedAt", "expiresAt",
  ])) return false;
  if (value.v !== RECEIPT_VERSION || value.kind !== RECEIPT_KIND) return false;
  if (!validIdentifier(value.messageId) || !validIdentifier(value.assistantId)
    || !validIdentifier(value.claimToken) || !validIdentifier(value.callId)
    || !validIdentifier(value.target)) return false;
  if (value.operation !== "discover" && value.operation !== "invoke") return false;
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)) return false;
  if (value.issuedAt < 0 || value.expiresAt <= value.issuedAt || value.expiresAt > value.issuedAt + RECEIPT_TTL_MS) return false;
  // A small clock-skew allowance avoids rejecting a receipt while still making
  // it an intentionally short per-dynamic-call credential.
  return value.issuedAt <= now + 5_000 && value.expiresAt > now;
}

export function issueForegroundOwnerToolReceipt(input: IssueForegroundOwnerToolReceiptInput): string {
  if (!validIdentifier(input.turn.messageId) || !validIdentifier(input.turn.assistantId)
    || !validIdentifier(input.turn.claimToken) || !validIdentifier(input.callId)
    || !validIdentifier(input.target)) {
    throw new Error("foreground owner tool receipt identifiers are invalid");
  }
  if (input.operation !== "discover" && input.operation !== "invoke") {
    throw new Error("foreground owner tool receipt operation is invalid");
  }
  const issuedAt = input.now ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
    throw new Error("foreground owner tool receipt issue time is invalid");
  }
  const payload: ForegroundOwnerToolReceiptPayload = Object.freeze({
    v: RECEIPT_VERSION,
    kind: RECEIPT_KIND,
    messageId: input.turn.messageId,
    assistantId: input.turn.assistantId,
    claimToken: input.turn.claimToken,
    callId: input.callId,
    operation: input.operation,
    target: input.target,
    issuedAt,
    expiresAt: issuedAt + RECEIPT_TTL_MS,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const receipt = `${RECEIPT_PREFIX}.${encodedPayload}.${signature(encodedPayload, receiptKey(input.secret))}`;
  if (receipt.length > RECEIPT_MAX_CHARS) throw new Error("foreground owner tool receipt exceeds its size bound");
  return receipt;
}

export function verifyForegroundOwnerToolReceipt(
  receipt: unknown,
  secret: string,
  now = Date.now(),
): ForegroundOwnerToolReceiptPayload | null {
  if (typeof receipt !== "string" || receipt.length < 80 || receipt.length > RECEIPT_MAX_CHARS) return null;
  const parts = receipt.split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX || !BASE64URL.test(parts[1]) || !HEX_64.test(parts[2])) return null;
  let payload: unknown;
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    if (decoded.length > RECEIPT_MAX_CHARS) return null;
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!validPayload(payload, now)) return null;
  let expected: string;
  try {
    expected = signature(parts[1], receiptKey(secret));
  } catch {
    return null;
  }
  return safeHexEqual(parts[2], expected) ? Object.freeze({ ...payload }) : null;
}
