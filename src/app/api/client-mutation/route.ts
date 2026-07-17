import type { NextRequest } from "next/server";
import {
  adminSessionHash,
  controlMutation,
  isSameOriginRequest,
  validateAdminSession,
} from "@/lib/control-session";

const ALLOWED = new Set([
  "creations:boardSave",
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
  "ui:setMood",
  "ui:setVideoCmd",
  "watches:cancel",
]);

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }
  const authTokenHash = await adminSessionHash(req);
  if (!(await validateAdminSession(authTokenHash))) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const path = String(body?.path ?? "");
  if (!ALLOWED.has(path) || !body?.args || typeof body.args !== "object" || Array.isArray(body.args)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  try {
    const value = await controlMutation(path, { ...body.args, authTokenHash });
    return Response.json({ ok: true, value });
  } catch {
    return Response.json({ ok: false }, { status: 409 });
  }
}
