import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { ensureWorkAttempt, patchJobWithRuntime } from "./controlPlane";
import { insertFreshTerminalWorkReceipt } from "./workReceiptAuthority";

async function appendApprovalLifecycle(ctx: any, job: any, type: string, message: string, stage: string, attempt: number) {
  const durable = await ctx.db.get(job._id) ?? job;
  const sequence = Number(durable.lifecycleSequence ?? 0) + 1;
  const predecessorKey = durable.lifecycleEventKey;
  const eventKey = `approval:${type}:${attempt}:${sequence}`;
  await ctx.db.insert("workEvents", {
    jobId: String(job._id), missionId: job.missionId, agentId: job.agentId, type, message, stage,
    attempt, causationId: `attempt:${String(job._id)}:${attempt}`, evidenceKind: "control",
    eventKey, sequence, predecessorKey, createdAt: Date.now(),
  });
  await ctx.db.patch(job._id, { lifecycleSequence: sequence, lifecycleEventKey: eventKey });
  const workAttempt = await ctx.db.query("workAttempts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", job._id).eq("attempt", attempt)).first();
  if (workAttempt) await ctx.db.patch(workAttempt._id, {
    status: type === "approval_declined" ? "cancelled" : heldByStage(stage) ? "paused" : "queued",
    completedAt: type === "approval_declined" ? Date.now() : undefined, lastEventSeq: sequence, lastEventKey: eventKey, lastEventAt: Date.now(),
  });
}

function heldByStage(stage: string) { return stage === "paused"; }

export const pending = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    return await ctx.db
      .query("approvals")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .order("desc")
      .take(30);
  },
});

export const decide = mutation({
  args: {
    jobId: v.string(),
    decision: v.union(v.literal("approved"), v.literal("declined")),
    authTokenHash: v.optional(v.string()),
    workerToken: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_job", (q: any) => q.eq("jobId", a.jobId))
      .take(20);
    const approval = approvals.find((row) => row.status === "pending");
    const jobId = ctx.db.normalizeId("jobs", a.jobId);
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!approval || approval.status !== "pending" || !jobId || !job || job.status !== "awaiting_approval") return false;
    const missionId = job.missionId ? ctx.db.normalizeId("missions", job.missionId) : null;
    const mission = missionId ? await ctx.db.get(missionId) : null;
    const heldByGoal = mission?.mode === "goal" && mission.status !== "running";
    const now = Date.now();
    const supervisorOwned =
      typeof job.missionId === "string"
      && Number.isSafeInteger(job.supervisorEpoch)
      && typeof job.supervisorDecisionKey === "string"
      && Number.isSafeInteger(job.supervisorJobOrdinal);
    if (a.decision === "declined" && supervisorOwned) {
      const attempt = job.attempt ?? 1;
      await ensureWorkAttempt(ctx, job, attempt, "awaiting_approval", now);
      await insertFreshTerminalWorkReceipt(ctx, job, attempt, {
        status: "cancelled",
        terminalCode: "approval_declined",
        recoveryDisposition: "operator_stop",
        acceptanceEvidence: [],
        artifacts: [`convex://approvals/${String(approval._id)}`],
        verification: "cancelled",
        terminalEventKey: `approval-declined:${attempt}`,
        result: "Daniel declined the protected recovery.",
      }, now);
    }
    await ctx.db.patch(approval._id, { status: a.decision, resolvedAt: now });
    await patchJobWithRuntime(ctx, job, {
      approvalStatus: a.decision,
      status: a.decision === "approved" ? (heldByGoal ? "paused" : "pending") : "cancelled",
      completedAt: a.decision === "declined" ? now : undefined,
      progress: a.decision === "approved"
        ? heldByGoal ? "approved — held until Goal Mode resumes" : "approved — queued"
        : "declined by Daniel",
      stage: a.decision === "approved" ? (heldByGoal ? "paused" : "queued") : "cancelled",
      nextRunAt: a.decision === "approved" && !heldByGoal ? Date.now() : undefined,
    });
    await appendApprovalLifecycle(ctx, job, a.decision === "approved" ? "approval_released" : "approval_declined",
      a.decision === "approved" ? "Daniel approved this work" : "Daniel declined this work",
      a.decision === "approved" ? (heldByGoal ? "paused" : "queued") : "cancelled", job.attempt ?? 1);
    return true;
  },
});
