import type { NextRequest } from "next/server";
import { wakeAgentFleet } from "@/lib/agent-fleet-dispatch";
import { cloudProviderAdmissionReadinessAtRuntime } from "@/lib/cloud-provider-admission-runtime";
import { controlMutation, controlQuery } from "@/lib/control-session";
import { routeGoal } from "@/lib/goal-mode";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";
import { isSafeSourceBranch } from "@/lib/source-admission";
import { resolveProjectSourceAdmission } from "@/lib/source-admission-server";
import { admissionMutationName, v2AdmissionEnabled } from "@/lib/mission-protocol-rollout";

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
  const requestedSourceBranch = body?.sourceBranch;
  if (requestedSourceBranch !== undefined && !isSafeSourceBranch(requestedSourceBranch)) {
    return Response.json({ ok: false, error: "Explicit source branch is invalid." }, { status: 400 });
  }
  const credentials = controlCredentials(actor);
  const route = routeGoal(goal, body?.repo ? String(body.repo) : undefined);
  const protocolV2 = v2AdmissionEnabled();
  if (requestedSourceBranch !== undefined && !protocolV2) {
    return Response.json({
      ok: false,
      error: "Explicit source branch requires the v2 mission protocol.",
    }, { status: 409 });
  }
  if (requestedSourceBranch !== undefined && !route.primaryRepo) {
    return Response.json({
      ok: false,
      error: "Explicit source branch requires a routed repository.",
    }, { status: 400 });
  }
  if (protocolV2) {
    const readiness = await cloudProviderAdmissionReadinessAtRuntime();
    if (!readiness.ready) {
      return Response.json({
        ok: false,
        code: "cloud_provider_not_ready",
        reason: readiness.code,
        retryable: true,
        error: "Goal Mode is temporarily unavailable because secure workspace readiness evidence is missing, expired, or does not match the deployed worker. No mission or Trigger worker was started. Open Options, choose Cloud worker release, select Verify release, wait for attested, then run Background readiness and retry.",
      }, {
        status: 503,
        headers: { "cache-control": "no-store", "retry-after": "60" },
      });
    }
  }
  let projectAdmission;
  if (protocolV2) {
    try {
      projectAdmission = await resolveProjectSourceAdmission(route.primaryRepo, requestedSourceBranch);
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : "Project source admission failed.",
      }, { status: 400 });
    }
  }
  const originThreadId = String(
    await controlQuery("ui:getActiveThread", credentials).catch(() => "main"),
  ) || "main";
  const created = await controlMutation(admissionMutationName("goal"), {
    ...credentials,
    goal,
    route: route.kind,
    routeReason: route.reason,
    primaryRepo: projectAdmission?.repository ?? route.primaryRepo,
    ...(protocolV2 ? { projectAdmission } : {}),
    infrastructureContext: route.infrastructureContext,
    originThreadId,
    priority: 98,
    risk: "high",
    acceptanceCriteria: Array.isArray(body?.acceptanceCriteria)
      ? body.acceptanceCriteria.map(String).map((item: string) => item.trim()).filter(Boolean).slice(0, 10)
      : undefined,
    maxBuildSessions: Number(body?.maxBuildSessions) || 6,
    maxRevisionWaves: Number(body?.maxRevisionWaves) || 2,
  }) as { missionId?: unknown; held?: boolean; reason?: unknown } | null;
  const missionId = String(created?.missionId ?? "");
  if (!missionId) return Response.json({ ok: false, error: "Goal Mode could not create its durable mission." }, { status: 503 });
  const woken = created?.held ? false : await wakeAgentFleet(`goal:${missionId}`).catch(() => false);
  return Response.json({
    ok: true,
    missionId,
    route: route.kind,
    woken,
    held: created?.held === true,
    holdReason: created?.held ? String(created.reason ?? "protocol_v1_admission_held") : undefined,
  }, { status: created?.held ? 202 : 201 });
}
