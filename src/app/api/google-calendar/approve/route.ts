import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import {
  createGooglePrimaryCalendarEvent,
  deleteManagedGooglePrimaryCalendarEvent,
  GoogleCalendarError,
  updateManagedGooglePrimaryCalendarEvent,
} from "@/lib/google-calendar";
import { verifyGoogleCalendarApprovalProposal } from "@/lib/google-calendar-approval.server";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { getTrip } from "@/lib/travel";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_BYTES = 5_000;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

function eventResponse(event: { title: string; start: string; end: string; allDay: boolean }) {
  return { title: event.title, start: event.start, end: event.end, allDay: event.allDay };
}

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
  let approval;
  try {
    approval = verifyGoogleCalendarApprovalProposal(body?.token);
  } catch {
    return Response.json({ ok: false, error: "calendar approval is invalid or expired" }, { status: 400 });
  }

  try {
    switch (approval.proposal.action) {
      case "create": {
        const binding = approval.proposal.appleMapsOfflinePreflight;
        if (binding) {
          const trip = await getTrip(binding.tripId, { storage: binding.storage }).catch(() => null);
          const preflight = trip?.doc.offlineMapPreflight;
          if (
            trip?.storage !== binding.storage ||
            preflight?.sourceKey !== binding.sourceKey ||
            preflight?.updatedAt !== binding.updatedAt ||
            preflight.calendarRefreshRequired === true
          ) {
            return Response.json({
              ok: false,
              error: "That Apple Maps itinerary changed before approval. Prepare a fresh protected Calendar approval.",
            }, { status: 409, headers: PRIVATE_HEADERS });
          }
        }
        const result = await createGooglePrimaryCalendarEvent(approval.proposal.event);
        return Response.json({
          ok: true,
          action: "create",
          created: result.created,
          event: eventResponse(result.event),
        }, { headers: PRIVATE_HEADERS });
      }
      case "update": {
        const result = await updateManagedGooglePrimaryCalendarEvent({
          eventId: approval.proposal.eventId,
          expectedEtag: approval.proposal.expectedEtag,
          event: approval.proposal.event,
        });
        return Response.json({
          ok: true,
          action: "update",
          event: eventResponse(result.event),
        }, { headers: PRIVATE_HEADERS });
      }
      case "delete": {
        const result = await deleteManagedGooglePrimaryCalendarEvent(
          approval.proposal.eventId,
          approval.proposal.expectedEtag,
        );
        return Response.json({ ok: true, action: "delete", deleted: result.deleted }, { headers: PRIVATE_HEADERS });
      }
    }
  } catch (error) {
    if (error instanceof GoogleCalendarError && /changed after the approval was prepared/i.test(error.message)) {
      return Response.json({
        ok: false,
        error: "That Jarvis-managed Google Calendar event changed before approval. Review it and request a fresh calendar change.",
      }, { status: 409, headers: PRIVATE_HEADERS });
    }
    // Provider payloads can contain private event details. The caller already
    // has the preview, so a stable safe error is more useful than reflection.
    return Response.json({
      ok: false,
      error: "Google Calendar could not apply that change. Reconnect Google in Options if its permission changed.",
    }, { status: 502, headers: PRIVATE_HEADERS });
  }
}
