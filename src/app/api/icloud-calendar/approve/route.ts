import type { NextRequest } from "next/server";
import { hasExactKeys, isJsonRecord, parseStrictJson } from "@/lib/bounded-json";
import { isSameOriginRequest } from "@/lib/control-session";
import { withAdminSession } from "@/lib/control-context";
import { convexMutation } from "@/lib/context";
import {
  createICloudEvent,
  ICloudCalendarConflictError,
  iCloudCalendarConfigured,
  writeICloudTravelCalendarEvent,
} from "@/lib/icloud-calendar";
import {
  verifyICloudCalendarApproval,
  verifyICloudCalendarTravelApproval,
  type VerifiedICloudCalendarTravelApproval,
} from "@/lib/icloud-calendar-approval.server";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

export const runtime = "nodejs";
export const maxDuration = 15;

const MAX_BODY_BYTES = 5_000;
const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

class ApprovalRequestError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "approval request too large" : "calendar approval is invalid or expired");
  }
}

function eventResponse(event: { title: string; start: number; end?: number; allDay: boolean }) {
  return { title: event.title, start: event.start, end: event.end, allDay: event.allDay };
}

function staleTravelApproval() {
  return Response.json({
    ok: false,
    error: "That Apple Maps itinerary changed before approval. Prepare a fresh protected iCloud Calendar approval.",
  }, { status: 409, headers: PRIVATE_HEADERS });
}

async function redeemTravelApproval(
  approval: VerifiedICloudCalendarTravelApproval,
  authTokenHash: string | undefined,
) {
  const proposal = approval.proposal;
  const binding = proposal.appleMapsOfflinePreflight;
  const claim = await withAdminSession(authTokenHash, () => convexMutation(
    "appleMapsOfflinePreflights:beginICloudCalendarApproval",
    {
      creationId: binding.tripId,
      sourceKey: binding.sourceKey,
      expectedPreflightUpdatedAt: binding.updatedAt,
      calendarUrl: binding.calendarUrl,
      action: proposal.action,
      nonce: approval.nonce,
      ...(proposal.action === "update" ? {
        eventUrl: proposal.eventUrl,
        expectedEtag: proposal.expectedEtag,
      } : {}),
    },
  )).catch(() => null) as { ok?: boolean; committed?: boolean } | null;
  if (claim?.ok !== true) return staleTravelApproval();
  if (claim.committed) {
    return Response.json({
      ok: true,
      action: proposal.action,
      created: false,
      event: eventResponse(proposal.event),
    }, { headers: PRIVATE_HEADERS });
  }

  try {
    const event = await writeICloudTravelCalendarEvent({
      action: proposal.action,
      calendarUrl: binding.calendarUrl,
      sourceKey: binding.sourceKey,
      revision: binding.updatedAt,
      nonce: approval.nonce,
      event: proposal.event,
      ...(proposal.action === "update" ? {
        eventUrl: proposal.eventUrl,
        expectedEtag: proposal.expectedEtag,
      } : {}),
    });
    const calendarEvent = {
      calendarUrl: event.calendarUrl,
      eventUrl: event.eventUrl,
      etag: event.etag,
      revision: binding.updatedAt,
      nonce: approval.nonce,
    };
    const observed = await withAdminSession(authTokenHash, () => convexMutation(
      "appleMapsOfflinePreflights:observeICloudCalendarApproval",
      {
        creationId: binding.tripId,
        sourceKey: binding.sourceKey,
        expectedPreflightUpdatedAt: binding.updatedAt,
        calendarUrl: binding.calendarUrl,
        action: proposal.action,
        nonce: approval.nonce,
        calendarEvent,
        ...(proposal.action === "update" ? {
          eventUrl: proposal.eventUrl,
          expectedEtag: proposal.expectedEtag,
        } : {}),
      },
    )).catch(() => null) as { ok?: boolean; current?: boolean } | null;
    if (observed?.ok !== true || observed.current !== true) return staleTravelApproval();
    const committed = await withAdminSession(authTokenHash, () => convexMutation(
      "appleMapsOfflinePreflights:commitICloudCalendarApproval",
      {
        creationId: binding.tripId,
        sourceKey: binding.sourceKey,
        expectedPreflightUpdatedAt: binding.updatedAt,
        calendarUrl: binding.calendarUrl,
        action: proposal.action,
        calendarEvent,
        ...(proposal.action === "update" ? { expectedEtag: proposal.expectedEtag } : {}),
      },
    )).catch(() => null) as { ok?: boolean } | null;
    if (committed?.ok !== true) return staleTravelApproval();
    return Response.json({
      ok: true,
      action: proposal.action,
      created: event.created,
      event: eventResponse(event),
    }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof ICloudCalendarConflictError) return staleTravelApproval();
    // CalDAV responses can contain private event/account details. Never
    // reflect them into chat; the card already contains the safe preview.
    return Response.json({
      ok: false,
      error: "iCloud Calendar could not apply that Apple Maps update. Check the iCloud Calendar connection, then prepare a fresh approval.",
    }, { status: 502, headers: PRIVATE_HEADERS });
  }
}

/** Read the small one-field receipt body without trusting Content-Length. */
async function readApprovalToken(req: NextRequest): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES) {
      throw new ApprovalRequestError(413);
    }
  }
  if (!req.body) throw new ApprovalRequestError(400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ApprovalRequestError(413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApprovalRequestError) throw error;
    throw new ApprovalRequestError(400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApprovalRequestError(400);
  }
  if (!isJsonRecord(parsed) || !hasExactKeys(parsed, ["token"]) || typeof parsed.token !== "string") {
    throw new ApprovalRequestError(400);
  }
  return parsed.token;
}

/**
 * This is the sole CalDAV write entry point. A model can prepare a receipt,
 * but the provider call requires a same-origin click from an enrolled owner.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false, error: "cross-origin approval rejected" }, { status: 403, headers: PRIVATE_HEADERS });
  }
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers: PRIVATE_HEADERS });
  if (!isOwnerActor(actor)) {
    return Response.json({ ok: false, error: "owner enrollment required" }, { status: 403, headers: PRIVATE_HEADERS });
  }
  if (!iCloudCalendarConfigured()) {
    return Response.json({
      ok: false,
      error: "iCloud Calendar is not configured in this Jarvis environment. Prepare a fresh approval after it is connected.",
    }, { status: 503, headers: PRIVATE_HEADERS });
  }
  let token: string;
  try {
    token = await readApprovalToken(req);
  } catch (error) {
    const status = error instanceof ApprovalRequestError ? error.status : 400;
    return Response.json(
      { ok: false, error: status === 413 ? "approval request too large" : "calendar approval is invalid or expired" },
      { status, headers: PRIVATE_HEADERS },
    );
  }
  let travelApproval: VerifiedICloudCalendarTravelApproval | undefined;
  try {
    travelApproval = verifyICloudCalendarTravelApproval(token);
  } catch {
    // Versioned travel receipts deliberately fail generic parsing and vice
    // versa. Try the legacy generic create shape only after this strict form.
  }
  if (travelApproval) return await redeemTravelApproval(travelApproval, actor.authTokenHash);

  let approval;
  try {
    approval = verifyICloudCalendarApproval(token);
  } catch {
    return Response.json({ ok: false, error: "calendar approval is invalid or expired" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  try {
    const event = await createICloudEvent({ ...approval.event, idempotencyKey: approval.nonce });
    return Response.json({
      ok: true,
      action: "create",
      created: event.created,
      event: eventResponse(event),
    }, { headers: PRIVATE_HEADERS });
  } catch {
    // CalDAV responses can contain private event/account details. Never
    // reflect them into chat; the card already contains the safe preview.
    return Response.json({
      ok: false,
      error: "iCloud Calendar could not add that event. Check the iCloud Calendar connection, then retry this approval before it expires.",
    }, { status: 502, headers: PRIVATE_HEADERS });
  }
}
