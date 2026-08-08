import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  SPECULATIVE_RESEARCH_LIMITS,
  SPECULATIVE_RESEARCH_RECEIPT_TTL_MS,
  SPECULATIVE_RESEARCH_TRUST,
  buildSpeculativeResearchQuery,
  buildUntrustedSpeculativeResearchContext,
  isSafeSpeculativeResearchId,
  isSpeculativeResearchApplicable,
  isSpeculativeResearchEligible,
  normalizeSpeculativeResearchBasis,
  sanitizeSpeculativeResearchSources,
  type SpeculativeResearchSidecar,
  type SpeculativeResearchSource,
} from "./speculative-research";

const RECEIPT_VERSION = 1 as const;
const RECEIPT_PREFIX = "sr1";
const RECEIPT_KIND = "jarvis.speculative-research" as const;
const HEX_64 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

type SpeculativeResearchReceiptPayload = Readonly<{
  v: typeof RECEIPT_VERSION;
  kind: typeof RECEIPT_KIND;
  trust: typeof SPECULATIVE_RESEARCH_TRUST;
  ownerBinding: string;
  threadId: string;
  requestId: string;
  basis: string;
  query: string;
  sources: readonly SpeculativeResearchSource[];
  issuedAt: number;
  expiresAt: number;
}>;

export type IssueSpeculativeResearchReceiptInput = Readonly<{
  actorAuthHash: string;
  threadId: string;
  requestId: string;
  basis: string;
  sources: unknown;
  now?: number;
}>;

export type IssuedSpeculativeResearchReceipt = Readonly<{
  receipt: string;
  query: string;
  sources: readonly SpeculativeResearchSource[];
  expiresAt: number;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function configuredReceiptKey(): Buffer {
  const configured = process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET ?? process.env.JARVIS_DISPATCH_TOKEN ?? "";
  const secret = Buffer.from(configured, "utf8");
  if (secret.byteLength < 32) throw new Error("speculative research receipt authority is not configured");
  return createHash("sha256").update("jarvis/speculative-research/receipt-key/v1\0").update(secret).digest();
}

function assertOwnerAuthHash(value: string): void {
  if (!HEX_64.test(value)) throw new Error("speculative research owner binding is invalid");
}

function ownerBinding(actorAuthHash: string): string {
  assertOwnerAuthHash(actorAuthHash);
  return createHash("sha256").update("jarvis/speculative-research/owner/v1\0").update(actorAuthHash).digest("hex");
}

function signature(encodedPayload: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update("jarvis/speculative-research/receipt/v1\0")
    .update(encodedPayload)
    .digest("hex");
}

function safeHexEqual(actual: string, wanted: string): boolean {
  if (!HEX_64.test(actual) || !HEX_64.test(wanted)) return false;
  const actualBytes = Buffer.from(actual, "hex");
  const wantedBytes = Buffer.from(wanted, "hex");
  return actualBytes.length === wantedBytes.length && timingSafeEqual(actualBytes, wantedBytes);
}

function immutableSources(input: unknown): readonly SpeculativeResearchSource[] {
  return Object.freeze(sanitizeSpeculativeResearchSources(input).map((source) => Object.freeze({ ...source })));
}

export function issueSpeculativeResearchReceipt(input: IssueSpeculativeResearchReceiptInput): IssuedSpeculativeResearchReceipt {
  assertOwnerAuthHash(input.actorAuthHash);
  if (!isSafeSpeculativeResearchId(input.threadId, SPECULATIVE_RESEARCH_LIMITS.threadIdChars)) throw new Error("speculative research thread id is invalid");
  if (!isSafeSpeculativeResearchId(input.requestId, SPECULATIVE_RESEARCH_LIMITS.requestIdChars)) throw new Error("speculative research request id is invalid");
  const issuedAt = input.now ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("speculative research issue time is invalid");
  const basis = normalizeSpeculativeResearchBasis(input.basis);
  const query = buildSpeculativeResearchQuery(basis);
  const sources = immutableSources(input.sources);
  if (!query || !isSpeculativeResearchEligible(basis) || sources.length === 0) throw new Error("speculative research evidence is empty or ineligible");
  if (!buildUntrustedSpeculativeResearchContext(query, sources)) throw new Error("speculative research evidence exceeds context bounds");

  const expiresAt = issuedAt + SPECULATIVE_RESEARCH_RECEIPT_TTL_MS;
  const payload: SpeculativeResearchReceiptPayload = Object.freeze({
    v: RECEIPT_VERSION,
    kind: RECEIPT_KIND,
    trust: SPECULATIVE_RESEARCH_TRUST,
    ownerBinding: ownerBinding(input.actorAuthHash),
    threadId: input.threadId,
    requestId: input.requestId,
    basis,
    query,
    sources,
    issuedAt,
    expiresAt,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const receipt = `${RECEIPT_PREFIX}.${encodedPayload}.${signature(encodedPayload, configuredReceiptKey())}`;
  if (receipt.length > SPECULATIVE_RESEARCH_LIMITS.receiptChars) throw new Error("speculative research receipt exceeds its size bound");
  return Object.freeze({ receipt, query, sources, expiresAt });
}

function parseReceipt(receipt: unknown): { payload: SpeculativeResearchReceiptPayload; encodedPayload: string; suppliedSignature: string } | null {
  if (typeof receipt !== "string" || receipt.length < 80 || receipt.length > SPECULATIVE_RESEARCH_LIMITS.receiptChars) return null;
  const parts = receipt.split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX || !BASE64URL.test(parts[1]) || !HEX_64.test(parts[2])) return null;
  let decoded: unknown;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    if (json.length > SPECULATIVE_RESEARCH_LIMITS.receiptChars) return null;
    decoded = JSON.parse(json);
  } catch {
    return null;
  }
  if (!record(decoded) || !exactKeys(decoded, ["v", "kind", "trust", "ownerBinding", "threadId", "requestId", "basis", "query", "sources", "issuedAt", "expiresAt"])) return null;
  return { payload: decoded as SpeculativeResearchReceiptPayload, encodedPayload: parts[1], suppliedSignature: parts[2] };
}

function validPayload(payload: SpeculativeResearchReceiptPayload, now: number): boolean {
  if (payload.v !== RECEIPT_VERSION || payload.kind !== RECEIPT_KIND || payload.trust !== SPECULATIVE_RESEARCH_TRUST) return false;
  if (!HEX_64.test(payload.ownerBinding)) return false;
  if (typeof payload.threadId !== "string" || !isSafeSpeculativeResearchId(payload.threadId, SPECULATIVE_RESEARCH_LIMITS.threadIdChars)) return false;
  if (typeof payload.requestId !== "string" || !isSafeSpeculativeResearchId(payload.requestId, SPECULATIVE_RESEARCH_LIMITS.requestIdChars)) return false;
  if (typeof payload.basis !== "string" || payload.basis !== normalizeSpeculativeResearchBasis(payload.basis) || !isSpeculativeResearchEligible(payload.basis)) return false;
  if (typeof payload.query !== "string" || payload.query !== buildSpeculativeResearchQuery(payload.basis)) return false;
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) return false;
  if (payload.issuedAt > now + 5_000 || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt) return false;
  if (payload.expiresAt - payload.issuedAt !== SPECULATIVE_RESEARCH_RECEIPT_TTL_MS) return false;
  if (!Array.isArray(payload.sources) || payload.sources.length === 0 || payload.sources.length > SPECULATIVE_RESEARCH_LIMITS.maxSources) return false;
  if (!payload.sources.every((source) => record(source) && exactKeys(source, ["title", "url", "snippet"]))) return false;
  const sanitized = sanitizeSpeculativeResearchSources(payload.sources);
  return sanitized.length === payload.sources.length && JSON.stringify(sanitized) === JSON.stringify(payload.sources);
}

export function promoteSpeculativeResearchReceipt(
  receipt: unknown,
  actorAuthHash: string,
  expectedThreadId: string,
  expectedRequestId: string,
  finalText: string,
  now = Date.now(),
): SpeculativeResearchSidecar | null {
  try {
    if (!Number.isSafeInteger(now) || now < 0) return null;
    assertOwnerAuthHash(actorAuthHash);
    const parsed = parseReceipt(receipt);
    if (!parsed || !validPayload(parsed.payload, now)) return null;
    const wantedSignature = signature(parsed.encodedPayload, configuredReceiptKey());
    if (!safeHexEqual(parsed.suppliedSignature, wantedSignature)) return null;
    if (!safeHexEqual(parsed.payload.ownerBinding, ownerBinding(actorAuthHash))) return null;
    if (parsed.payload.threadId !== expectedThreadId || parsed.payload.requestId !== expectedRequestId) return null;
    if (!isSpeculativeResearchApplicable(parsed.payload.basis, finalText)) return null;
    const context = buildUntrustedSpeculativeResearchContext(parsed.payload.query, parsed.payload.sources);
    if (!context) return null;
    return Object.freeze({ basis: parsed.payload.basis, context, expiresAt: parsed.payload.expiresAt });
  } catch {
    return null;
  }
}
