import type { NextRequest } from "next/server";
import { controlMutation } from "@/lib/control-session";
import { wakeAgentFleet } from "@/lib/agent-fleet-dispatch";
import { controlActor, controlCredentials } from "@/lib/request-auth";

const ACTIONS = new Set(["approve", "decline", "pause", "resume", "cancel", "retry", "answer", "steer"]);

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  const credentials = controlCredentials(actor);
  const body = await req.json().catch(() => ({}));
  const jobId = String(body?.jobId ?? "");
  const missionId = String(body?.missionId ?? "");
  const action = String(body?.action ?? "");
  if ((!jobId && !missionId) || !ACTIONS.has(action)) return Response.json({ ok: false }, { status: 400 });

  let ok: unknown = false;
  let shouldWake = false;
  if (missionId) {
    if (!new Set(["pause", "resume", "cancel", "steer"]).has(action)) return Response.json({ ok: false }, { status: 400 });
    const input = action === "steer" ? String(body?.input ?? "").trim() : undefined;
    if (action === "steer" && !input) return Response.json({ ok: false }, { status: 400 });
    ok = await controlMutation("goalMode:control", { id: missionId, action, input, ...credentials });
  } else if (action === "approve" || action === "decline") {
    ok = await controlMutation("approvals:decide", {
      jobId,
      decision: action === "approve" ? "approved" : "declined",
      ...credentials,
    });
  } else if (action === "answer") {
    const answer = String(body?.input ?? "").trim();
    if (!answer) return Response.json({ ok: false }, { status: 400 });
    ok = await controlMutation("jobs:provideInput", { jobId, answer, ...credentials });
  } else {
    const input = action === "steer" ? String(body?.input ?? "").trim() : undefined;
    if (action === "steer" && !input) return Response.json({ ok: false }, { status: 400 });
    ok = await controlMutation("jobs:control", { jobId, action, input, ...credentials });
  }
  if (ok === true && missionId) {
    const { goalCoordinationDemand, syncExternalGoalControls, syncExternalGoalRevisions } = await import("@/trigger/goal-runtime");
    await syncExternalGoalControls().catch(() => null);
    await syncExternalGoalRevisions().catch(() => null);
    if (action === "resume" || action === "steer") {
      shouldWake = true;
      const demand = await goalCoordinationDemand().catch(() => null);
      if (demand) shouldWake = demand.needed === true;
    }
  } else if (ok === true && ["approve", "resume", "retry", "answer", "steer"].includes(action)) {
    shouldWake = true;
  }
  if (shouldWake) {
    await wakeAgentFleet(`${missionId ? "goal" : "job"}-${action}:${missionId || jobId}`).catch(() => false);
  }
  return Response.json(
    { ok: ok === true, ...(ok === true ? {} : { error: "That work item cannot apply this control from its current state." }) },
    { status: ok === true ? 200 : 409 },
  );
}
