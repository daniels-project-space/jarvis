import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import { createGooglePrimaryCalendarEvent } from "@/lib/google-calendar";
import { verifyGoogleCalendarApproval } from "@/lib/google-calendar-approval.server";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_BYTES = 5_000;

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ ok: false, error: "cross-origin approval rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ ok: false, error: "owner enrollment required" }, { status: 403 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "approval request too large" }, { status: 413 });
  }
  const body = await req.json().catch(() => null) as { token?: unknown } | null;
  let event;
  try {
    event = verifyGoogleCalendarApproval(body?.token);
  } catch {
    return Response.json({ ok: false, error: "calendar approval is invalid or expired" }, { status: 400 });
  }
  try {
    const result = await createGooglePrimaryCalendarEvent(event);
    return Response.json({
      ok: true,
      created: result.created,
      event: {
        title: result.event.title,
        start: result.event.start,
        end: result.event.end,
        allDay: result.event.allDay,
      },
    }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    // Provider payloads can contain private event details. The caller already
    // has the preview, so a stable safe error is more useful than reflection.
    return Response.json({
      ok: false,
      error: "Google Calendar could not add that event. Reconnect Google in Options if its permission changed.",
    }, { status: 502, headers: { "cache-control": "private, no-store" } });
  }
}
