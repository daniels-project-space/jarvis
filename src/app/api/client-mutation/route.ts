import type { NextRequest } from "next/server";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
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
]);

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
    const value = await controlMutation(path, { ...body.args, ...controlCredentials(actor) });
    return Response.json({ ok: true, value });
  } catch {
    return Response.json({ ok: false }, { status: 409 });
  }
}
