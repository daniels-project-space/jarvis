import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { gmailSendDraft } from "@/lib/gmail";
import { GmailSendApprovalError, verifyGmailSendApproval } from "@/lib/gmail-send-approval.server";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 4 * 1024;
const PRIVATE_HEADERS = { "cache-control": "private, no-store, max-age=0" };

/**
 * Redeem a send approval. This is the ONLY path that sends mail as Daniel.
 *
 * Three things have to hold: an owner-enrolled same-origin actor, a receipt
 * this server signed, and a draft id sealed inside that receipt. A tool can
 * issue a receipt but cannot call this, and the receipt names a draft rather
 * than carrying message text — so the mail that goes out is byte-identical to
 * what Daniel read in his own Gmail drafts.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin send rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });

  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return Response.json({ error: "send approval request too large" }, { status: 413 });
  }

  let proposal;
  try {
    const body = await req.json().catch(() => null) as { approval?: unknown } | null;
    proposal = verifyGmailSendApproval(body?.approval);
  } catch (error) {
    const message = error instanceof GmailSendApprovalError ? error.message : "Send approval is invalid or expired.";
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const sent = await gmailSendDraft(proposal.draftId);
    return Response.json({
      ok: true,
      status: "sent",
      to: proposal.to,
      subject: proposal.subject,
      messageId: sent.messageId,
      threadId: sent.threadId,
    }, { headers: PRIVATE_HEADERS });
  } catch {
    // Gmail's response can include private message/account details. The owner
    // already reviewed the draft, so use a stable recovery message instead.
    return Response.json({
      error: "Gmail could not send that approved draft. Reconnect Google in Options if its permission changed.",
    }, { status: 502, headers: PRIVATE_HEADERS });
  }
}
