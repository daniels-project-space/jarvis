import type { NextRequest } from "next/server";
import { controlMutation } from "@/lib/control-session";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ ok: false, error: "owner enrollment required" }, { status: 403 });
  const credentials = controlCredentials(actor);
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
      ...credentials,
    });
    return Response.json({ ok: true });
  }

  if (action === "clear_thread") {
    const count = await controlMutation("chatQueue:clearThread", {
      threadId: body?.threadId ? String(body.threadId) : undefined,
      ...credentials,
    });
    return Response.json({ ok: true, count });
  }

  if (action === "set_active_thread") {
    const thread = String(body?.thread ?? "").slice(0, 160);
    if (!thread) return Response.json({ ok: false }, { status: 400 });
    await controlMutation("ui:setActiveThread", {
      thread,
      title: body?.title ? String(body.title).slice(0, 160) : undefined,
      ...credentials,
    });
    return Response.json({ ok: true });
  }

  if (action === "set_agent_provider") {
    if (body?.provider !== "codex") {
      return Response.json({ ok: false, error: "Jarvis intelligence is Codex CLI only." }, { status: 400 });
    }
    await controlMutation("ui:setAgentProvider", { provider: "codex", ...credentials });
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
      ...credentials,
    });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false }, { status: 400 });
}
