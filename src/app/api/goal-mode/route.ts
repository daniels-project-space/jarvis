import type { NextRequest } from "next/server";
import { wakeAgentFleet } from "@/lib/agent-fleet-dispatch";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { routeGoal } from "@/lib/goal-mode";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";
import { resolveProjectSourceAdmission } from "@/lib/source-admission-server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ ok: false, error: "owner enrollment required" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const goal = String(body?.goal ?? "").trim().slice(0, 500);
  if (goal.length < 12) {
    return Response.json({ ok: false, error: "Describe the concrete outcome in at least 12 characters." }, { status: 400 });
  }
  const credentials = controlCredentials(actor);
  const route = routeGoal(goal, body?.repo ? String(body.repo) : undefined);
  let projectAdmission;
  try {
    projectAdmission = await resolveProjectSourceAdmission(route.primaryRepo);
  } catch (error) {
    return Response.json({
      ok: false,
      error: error instanceof Error ? error.message : "Project source admission failed.",
    }, { status: 400 });
  }
  const originThreadId = String(
    await controlQuery("ui:getActiveThread", credentials).catch(() => "main"),
  ) || "main";
  const created: any = await controlMutation("goalMode:create", {
    ...credentials,
    goal,
    route: route.kind,
    routeReason: route.reason,
    primaryRepo: projectAdmission.repository,
    projectAdmission,
    infrastructureContext: route.infrastructureContext,
    originThreadId,
    priority: 98,
    risk: "high",
    acceptanceCriteria: Array.isArray(body?.acceptanceCriteria)
      ? body.acceptanceCriteria.map(String).map((item: string) => item.trim()).filter(Boolean).slice(0, 10)
      : undefined,
    maxBuildSessions: Number(body?.maxBuildSessions) || 6,
    maxRevisionWaves: Number(body?.maxRevisionWaves) || 2,
  });
  const missionId = String(created?.missionId ?? "");
  if (!missionId) return Response.json({ ok: false, error: "Goal Mode could not create its durable mission." }, { status: 503 });
  await controlMutation("ui:setPanel", {
    ...credentials,
    type: "fleet",
    value: JSON.stringify({ missionId, mode: "goal" }),
    title: `goal · ${goal.slice(0, 44)}`,
  }).catch(() => null);
  const woken = await wakeAgentFleet(`goal:${missionId}`).catch(() => false);
  return Response.json({ ok: true, missionId, route: route.kind, woken }, { status: 201 });
}
