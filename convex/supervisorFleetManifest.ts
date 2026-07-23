import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  readAttemptExecutionAuthority,
  readJobSchedulingAuthority,
} from "./controlPlane";
import { writeLineageKey } from "../src/lib/work-scheduler";
import {
  SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION,
  canonicalSupervisorFleetManifestMembers,
  supervisorFleetManifestDigest,
  supervisorFleetMemberDigest,
  type SupervisorFleetManifestBinding,
  type SupervisorFleetManifestMember,
} from "../src/lib/supervisor-fleet-manifest";

export type StoredSupervisorFleetManifestMember = Omit<
  SupervisorFleetManifestMember,
  | "jobId"
  | "workAttemptId"
  | "schedulingAdmissionId"
  | "workOrderRevisionId"
  | "approvalId"
  | "deliveryAttemptId"
  | "reviewReceiptId"
> & {
  jobId: Id<"jobs">;
  workAttemptId: Id<"workAttempts">;
  schedulingAdmissionId: Id<"jobSchedulingAdmissions">;
  workOrderRevisionId: Id<"workOrderRevisions">;
  approvalId?: Id<"approvals">;
  deliveryAttemptId?: Id<"deliveryAttempts">;
  reviewReceiptId?: Id<"reviewReceipts">;
};

type ResumeFleetManifest = {
  protocolVersion: typeof SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION;
  members: StoredSupervisorFleetManifestMember[];
  memberCount: number;
  fleetDigest: string;
};

async function exactApprovedApproval(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
): Promise<Doc<"approvals"> | null> {
  if (!job.approvalRequired) return null;
  if (job.approvalStatus !== "approved") return null;
  const [pending, approved] = await Promise.all([
    ctx.db
      .query("approvals")
      .withIndex("by_job_status", (q) =>
        q.eq("jobId", String(job._id)).eq("status", "pending")
      )
      .take(1),
    ctx.db
      .query("approvals")
      .withIndex("by_job_status", (q) =>
        q.eq("jobId", String(job._id)).eq("status", "approved")
      )
      .take(2),
  ]);
  const row = approved[0];
  return pending.length === 0
      && approved.length === 1
      && row
      && Number.isSafeInteger(row.resolvedAt)
      && Number(row.resolvedAt) > 0
    ? row
    : null;
}

async function dependenciesAreReady(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
): Promise<boolean> {
  if (job.planParentMissionId) return false;
  const dependencies = job.dependsOn ?? [];
  if (dependencies.length > 16) return false;
  const rows = await Promise.all(dependencies.map((dependency) => {
    const id = ctx.db.normalizeId("jobs", dependency);
    return id ? ctx.db.get(id) : Promise.resolve(null);
  }));
  return rows.length === dependencies.length
    && rows.every((row) => row?.status === "done");
}

async function manifestMember(
  ctx: Pick<MutationCtx, "db">,
  job: Doc<"jobs">,
  now: number,
): Promise<StoredSupervisorFleetManifestMember | null> {
  if (
    job.status === "awaiting_approval"
    || job.dispatchReady !== true
    || typeof job.nextRunAt !== "number"
    || job.nextRunAt > now
  ) {
    return null;
  }
  if (
    job.status !== "pending"
    || job.dispatchId
    || job.workerRunId
    || job.deliveryRunId
    || job.integrationAttemptId
    || !await dependenciesAreReady(ctx, job)
  ) {
    throw new Error("Resumed fleet member is not a clean pending candidate");
  }
  const approval = await exactApprovedApproval(ctx, job);
  if (job.approvalRequired && !approval) return null;

  const attemptNumber = Number(job.attempt ?? 1);
  const [scheduling, execution] = await Promise.all([
    readJobSchedulingAuthority(ctx, job),
    readAttemptExecutionAuthority(ctx, job, attemptNumber),
  ]);
  if (
    !scheduling
    || !execution
    || execution.schedulingBindingDigest !== scheduling.digest
    || String(execution.workOrderRevisionId)
      !== String(job.workOrderRevisionId)
    || execution.workOrderRevision !== job.workOrderRevision
    || execution.workOrderRevisionDigest !== job.workOrderRevisionDigest
    || !Number.isSafeInteger(job.priority)
    || !Number.isSafeInteger(job.createdAt)
  ) {
    throw new Error("Resumed fleet member lost immutable execution authority");
  }
  const phase = job.verificationVerdict === "pass" && job.reviewReceiptId
    ? "delivery" as const
    : "specialist" as const;
  if (
    phase === "specialist"
    && (
      !["pending", "queued"].includes(execution.attempt.status)
      || execution.attempt.dispatchId
      || execution.attempt.workerRunId
      || execution.attempt.sessionId
      || execution.attempt.launchedAt
      || execution.attempt.completedAt
    )
  ) {
    throw new Error("Resumed specialist member attempt is not dormant");
  }
  if (
    phase === "delivery"
    && (
      execution.attempt.status !== "done"
      || !Number.isSafeInteger(execution.attempt.completedAt)
      || Number(execution.attempt.completedAt) <= 0
      || typeof execution.attempt.workerRunId !== "string"
      || typeof execution.attempt.sessionId !== "string"
      || typeof execution.attempt.launchedAt !== "number"
      || typeof execution.attempt.dispatchId !== "string"
      || execution.attempt.dispatchPhase !== "specialist"
      || !execution.attempt.dispatchReceiptId
      || typeof execution.attempt.dispatchReceiptDigest !== "string"
      || typeof execution.attempt.dispatchPayloadDigest !== "string"
    )
  ) {
    throw new Error(
      "Resumed delivery member lost its completed specialist attempt",
    );
  }
  let deliveryFields: Pick<
    StoredSupervisorFleetManifestMember,
    | "deliveryAttemptId"
    | "deliverySourceWorkAttempt"
    | "deliveryGeneration"
    | "reviewReceiptId"
    | "reviewReceiptDigest"
  > = {};
  if (phase === "delivery") {
    const [delivery, review] = await Promise.all([
      job.activeDeliveryAttemptId
        ? ctx.db.get(job.activeDeliveryAttemptId)
        : Promise.resolve(null),
      job.reviewReceiptId
        ? ctx.db.get(job.reviewReceiptId)
        : Promise.resolve(null),
    ]);
    if (
      !delivery
      || !review
      || delivery.status !== "checkpointed"
      || delivery.dispatchId
      || delivery.deliveryRunId
      || delivery.leaseOwner
      || delivery.leaseToken
      || delivery.leaseUntil
      || delivery.jobId !== job._id
      || delivery.sourceWorkAttempt !== attemptNumber
      || delivery.generation !== job.deliveryGeneration
      || delivery.authorityDigest !== execution.authorityDigest
      || delivery.schedulingBindingDigest
        !== execution.schedulingBindingDigest
      || String(delivery.workOrderRevisionId)
        !== String(execution.workOrderRevisionId)
      || delivery.workOrderRevision !== execution.workOrderRevision
      || delivery.workOrderRevisionDigest
        !== execution.workOrderRevisionDigest
      || String(delivery.reviewReceiptId) !== String(review._id)
      || delivery.reviewReceiptDigest !== review.receiptDigest
      || review.jobId !== job._id
      || review.attempt !== attemptNumber
      || review.receiptDigest !== job.reviewReceiptDigest
      || review.authorityDigest !== execution.authorityDigest
      || review.schedulingBindingDigest
        !== execution.schedulingBindingDigest
      || String(review.workOrderRevisionId)
        !== String(execution.workOrderRevisionId)
      || review.workOrderRevision !== execution.workOrderRevision
      || review.workOrderRevisionDigest
        !== execution.workOrderRevisionDigest
    ) {
      throw new Error("Resumed delivery member lost exact review authority");
    }
    deliveryFields = {
      deliveryAttemptId: delivery._id,
      deliverySourceWorkAttempt: delivery.sourceWorkAttempt,
      deliveryGeneration: delivery.generation,
      reviewReceiptId: review._id,
      reviewReceiptDigest: review.receiptDigest,
    };
  } else if (
    job.activeDeliveryAttemptId
    || job.reviewReceiptId
    || job.reviewReceiptDigest
  ) {
    throw new Error("Specialist fleet member carries delivery authority");
  }

  const core = {
    protocolVersion: SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION,
    jobId: job._id,
    workAttemptId: execution.attempt._id,
    attempt: attemptNumber,
    phase,
    authorityDigest: execution.authorityDigest,
    schedulingAdmissionId: scheduling.admission._id,
    schedulingBindingDigest: scheduling.digest,
    schedulingGroupKey: scheduling.binding.schedulingGroupKey,
    workOrderRevisionId: execution.workOrderRevisionId,
    workOrderRevision: execution.workOrderRevision,
    workOrderRevisionDigest: execution.workOrderRevisionDigest,
    nextRunAt: job.nextRunAt,
    priority: Number(job.priority),
    createdAt: Number(job.createdAt),
    writeLineage: writeLineageKey(job) ?? undefined,
    ...(approval
      ? {
        approvalId: approval._id,
        approvalResolvedAt: approval.resolvedAt!,
      }
      : {}),
    ...deliveryFields,
  };
  return {
    ...core,
    memberDigest: await supervisorFleetMemberDigest(core),
  };
}

export async function buildSupervisorResumeFleetManifest(
  ctx: Pick<MutationCtx, "db">,
  args: {
    missionId: Id<"missions">;
    affectedJobIds: readonly Id<"jobs">[];
    binding: SupervisorFleetManifestBinding;
    now: number;
  },
): Promise<ResumeFleetManifest> {
  const sortedIds = [...args.affectedJobIds].sort((left, right) =>
    String(left).localeCompare(String(right))
  );
  if (
    new Set(sortedIds.map(String)).size !== sortedIds.length
    || sortedIds.length > 24
  ) {
    throw new Error("Resumed fleet membership is invalid");
  }
  const members: StoredSupervisorFleetManifestMember[] = [];
  for (const jobId of sortedIds) {
    const job = await ctx.db.get(jobId);
    if (
      !job
      || String(job.missionId ?? "") !== String(args.missionId)
    ) {
      throw new Error("Resumed fleet member left its mission");
    }
    const member = await manifestMember(ctx, job, args.now);
    if (member) members.push(member);
  }
  const canonical = canonicalSupervisorFleetManifestMembers(
    members,
  ) as StoredSupervisorFleetManifestMember[];
  return {
    protocolVersion: SUPERVISOR_FLEET_MANIFEST_PROTOCOL_VERSION,
    members: canonical,
    memberCount: canonical.length,
    fleetDigest: await supervisorFleetManifestDigest(
      args.binding,
      canonical,
    ),
  };
}
