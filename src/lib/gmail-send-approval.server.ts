import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GMAIL_SEND_APPROVAL_MARKER } from "./gmail-send-approval-marker";

// Approval receipts for sending mail as Daniel.
//
// Same owner-approval shape as the Calendar writer: a tool can PREPARE a send but
// cannot perform one. It creates a real Gmail draft, then issues a signed
// receipt naming that draft id. Only a same-origin owner click can redeem it.
//
// The receipt seals the draft ID, not the message text, and that is the point:
// the bytes live in Daniel's own Gmail drafts where he can read them before
// approving. What he reviews and what goes out are necessarily identical —
// there is no path that composes and sends in one step.

const APPROVAL_VERSION = 1;
const APPROVAL_TTL_MS = 15 * 60_000;
const MAX_TOKEN_BYTES = 2_048;

export class GmailSendApprovalError extends Error {}

export type GmailSendProposal = {
  draftId: string;
  to: string;
  subject: string;
  /** Short preview only — for the approval card, never the send path. */
  preview: string;
};

type ApprovalPayload = {
  version: typeof APPROVAL_VERSION;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  proposal: GmailSendProposal;
};

function approvalKey(): Buffer {
  const configured = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!configured) throw new GmailSendApprovalError("Gmail send approval is not configured.");
  const encryptionKey = Buffer.from(configured, "base64");
  if (encryptionKey.byteLength !== 32) throw new GmailSendApprovalError("Gmail send approval is not configured.");
  // Domain-separated from the calendar key so a calendar receipt can never be
  // replayed as a send receipt.
  return createHash("sha256")
    .update("jarvis-gmail-send-approval-v1\0")
    .update(encryptionKey)
    .digest();
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", approvalKey()).update(encodedPayload).digest();
}

function encodedApprovalToken(payload: ApprovalPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
}

function normalizedProposal(proposal: GmailSendProposal): GmailSendProposal {
  const draftId = String(proposal?.draftId ?? "").trim();
  if (!draftId || draftId.length > 256) throw new GmailSendApprovalError("A draft id is required.");
  return {
    draftId,
    to: String(proposal?.to ?? "").trim().slice(0, 320),
    subject: String(proposal?.subject ?? "").trim().slice(0, 300),
    preview: String(proposal?.preview ?? "").trim().slice(0, 500),
  };
}

export function issueGmailSendApproval(proposal: GmailSendProposal, now = Date.now()): string {
  const base: ApprovalPayload = {
    version: APPROVAL_VERSION,
    issuedAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
    proposal: normalizedProposal(proposal),
  };
  let preview = base.proposal.preview;
  let token = encodedApprovalToken(base);
  // The signed receipt is also parsed client-side before it reaches the
  // owner-only send control. Trim only the non-authoritative preview until it
  // fits the strict verifier cap; never issue a receipt that cannot redeem.
  while (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES && preview) {
    preview = preview.slice(0, -1);
    token = encodedApprovalToken({ ...base, proposal: { ...base.proposal, preview } });
  }
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new GmailSendApprovalError("Gmail send approval is too large.");
  }
  return token;
}

export function verifyGmailSendApproval(token: unknown, now = Date.now()): GmailSendProposal {
  if (typeof token !== "string" || token.length === 0 || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new GmailSendApprovalError("Send approval is invalid or expired.");
  }
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) throw new GmailSendApprovalError("Send approval is invalid or expired.");

  const expected = sign(encodedPayload);
  const presented = Buffer.from(signature, "base64url");
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    throw new GmailSendApprovalError("Send approval is invalid or expired.");
  }

  let payload: ApprovalPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new GmailSendApprovalError("Send approval is invalid or expired.");
  }
  if (payload.version !== APPROVAL_VERSION) throw new GmailSendApprovalError("Send approval is invalid or expired.");
  if (typeof payload.expiresAt !== "number" || payload.expiresAt <= now) {
    throw new GmailSendApprovalError("Send approval has expired — re-draft to get a fresh one.");
  }
  return normalizedProposal(payload.proposal);
}

export function gmailSendApprovalMarker(token: string): string {
  return `[${GMAIL_SEND_APPROVAL_MARKER}:${token}]`;
}
