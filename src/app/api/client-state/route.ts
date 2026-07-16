import type { NextRequest } from "next/server";
import { adminSessionHash, controlMutation, validateAdminSession } from "@/lib/control-session";

export async function POST(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!(await validateAdminSession(authTokenHash))) return Response.json({ ok: false }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");

  if (action === "log_turn") {
    const role = String(body?.role ?? "");
    const text = String(body?.text ?? "").slice(0, 20_000);
    if (!text || !["user", "assistant"].includes(role)) return Response.json({ ok: false }, { status: 400 });
    await controlMutation("chatQueue:logTurn", {
      threadId: body?.threadId ? String(body.threadId) : undefined,
      role,
      text,
      model: body?.model ? String(body.model) : undefined,
      authTokenHash,
    });
    return Response.json({ ok: true });
  }

  if (action === "clear_thread") {
    const count = await controlMutation("chatQueue:clearThread", {
      threadId: body?.threadId ? String(body.threadId) : undefined,
      authTokenHash,
    });
    return Response.json({ ok: true, count });
  }

  if (action === "set_active_thread") {
    const thread = String(body?.thread ?? "").slice(0, 160);
    if (!thread) return Response.json({ ok: false }, { status: 400 });
    await controlMutation("ui:setActiveThread", {
      thread,
      title: body?.title ? String(body.title).slice(0, 160) : undefined,
      authTokenHash,
    });
    return Response.json({ ok: true });
  }

  if (action === "set_agent_provider") {
    const provider = body?.provider === "claude" ? "claude" : body?.provider === "codex" ? "codex" : null;
    if (!provider) return Response.json({ ok: false }, { status: 400 });
    await controlMutation("ui:setAgentProvider", { provider, authTokenHash });
    return Response.json({ ok: true });
  }

  if (action === "set_location") {
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Response.json({ ok: false }, { status: 400 });
    await controlMutation("ui:setLocation", {
      lat,
      lng,
      label: body?.label ? String(body.label).slice(0, 160) : undefined,
      authTokenHash,
    });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false }, { status: 400 });
}
