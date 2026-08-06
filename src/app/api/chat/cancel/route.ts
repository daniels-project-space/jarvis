import type { NextRequest } from "next/server";
import { convexMutation } from "@/lib/context";
import { controlActor, controlCredentials } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });

  let messageId = "";
  let threadId = "main";
  try {
    const body = await req.json();
    messageId = String(body?.messageId ?? "").trim();
    threadId = String(body?.threadId ?? "main").trim() || "main";
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!messageId) return Response.json({ error: "messageId is required" }, { status: 400 });

  const credentials = actor.kind === "guest" ? { guestId: actor.guestId } : controlCredentials(actor);
  const cancellation = await convexMutation("chatQueue:cancelTurn", {
    messageId,
    threadId,
    ...credentials,
  }) as {
    status: string;
    messageId?: string;
    fenceReceipt?: string;
  };

  if (cancellation.status === "missing") {
    return Response.json({ error: "turn not found" }, { status: 404 });
  }
  if (cancellation.status === "completed") {
    return Response.json({ ok: false, cancellation: "completed" }, { status: 409 });
  }
  if (
    cancellation.status !== "cancelled" ||
    cancellation.messageId !== messageId ||
    !cancellation.fenceReceipt
  ) {
    return Response.json({ error: "cancellation fence unavailable" }, { status: 503 });
  }

  // This receipt comes from the same Convex transaction that terminally
  // fences the turn. The client must not make retry available without it.
  return Response.json({
    ok: true,
    cancellation: "cancelled",
    messageId: cancellation.messageId,
    fenceReceipt: cancellation.fenceReceipt,
  });
}
