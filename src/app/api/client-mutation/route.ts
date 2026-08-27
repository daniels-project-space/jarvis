import type { NextRequest } from "next/server";
import { controlMutation, controlQuery, isSameOriginRequest } from "@/lib/control-session";
import { privateR2Delete } from "@/lib/private-r2";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

const ALLOWED = new Set([
  "creations:boardSave",
  "creations:boardLayoutSave",
  "creations:sceneLayoutSave",
  "creations:update",
  "creations:remove",
  "push:saveSub",
  "push:deleteSub",
  "reminders:due",
  "reminders:complete",
  "reminders:cancel",
  "ui:setPanel",
  "ui:clearPanel",
  "ui:claimVoice",
  "ui:electVoice",
  "ui:setLiveOn",
  "ui:setStandbyListener",
  "ui:setMood",
  "ui:setVideoCmd",
  "watchRules:cancel",
  // Notification bell. Read receipts and preferences only -- nothing here can
  // create a watch, send anything, or reach outside the app.
  "watchRules:markEventsSeen",
  "watchRules:dismissEvent",
  "notificationPrefs:update",
  // Browser errands remain owner decisions all the way down: this same-origin
  // owner route is the only UI entry point, and Convex independently rejects
  // worker/model credentials for both mutations.
  "browserErrands:decide",
  "browserErrands:expireStale",
]);

async function removeCreationWithPrivateAsset(
  args: Record<string, unknown>,
  credentials: ReturnType<typeof controlCredentials>,
) {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) throw new Error("creation id is required");

  // Metadata deletion alone must never turn a private creation asset into an
  // unreachable R2 orphan. The narrow server-side query binds the opaque key
  // to this exact authenticated creation; clients never supply a storage key.
  const media = await controlQuery("creations:getForMedia", { id, ...credentials }) as {
    assetR2Key?: unknown;
  } | null;
  if (typeof media?.assetR2Key === "string") {
    // R2 DELETE accepts an already-removed key, so if the later Convex
    // mutation is interrupted the same owner retry safely finishes removal.
    await privateR2Delete(media.assetR2Key);
  }
  return await controlMutation("creations:remove", { ...args, ...credentials });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const actor = await controlActor(req);
  if (!actor) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (!isOwnerActor(actor)) return Response.json({ ok: false, error: "owner enrollment required" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const path = String(body?.path ?? "");
  if (!ALLOWED.has(path) || !body?.args || typeof body.args !== "object" || Array.isArray(body.args)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  try {
    const credentials = controlCredentials(actor);
    const value = path === "creations:remove"
      ? await removeCreationWithPrivateAsset(body.args, credentials)
      : await controlMutation(path, { ...body.args, ...credentials });
    return Response.json({ ok: true, value });
  } catch {
    return Response.json({ ok: false }, { status: 409 });
  }
}
