import type { NextRequest } from "next/server";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { gmailSendDraft } from "@/lib/gmail";
import { GmailSendApprovalError, verifyGmailSendApproval } from "@/lib/gmail-send-approval.server";

export const runtime = "nodejs";

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
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });

  let proposal;
  try {
    const { approval } = await req.json();
    proposal = verifyGmailSendApproval(approval);
  } catch (error) {
    const message = error instanceof GmailSendApprovalError ? error.message : "Send approval is invalid or expired.";
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const sent = await gmailSendDraft(proposal.draftId);
    return Response.json({
      status: "sent",
      to: proposal.to,
      subject: proposal.subject,
      messageId: sent.messageId,
      threadId: sent.threadId,
    });
  } catch (error) {
    return Response.json(
      { error: `Send failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}
