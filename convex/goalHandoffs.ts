import {
  GOAL_DAG_MAX_NODES,
  GOAL_HANDOFF_ARTIFACT_MAX,
  GOAL_HANDOFF_SUMMARY_MAX_CHARS,
} from "../src/lib/goal-dag";
import { readAttemptExecutionAuthority } from "./controlPlane";

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function handoffEnvelope(row: any) {
  return {
    label: String(row.sourceNodeId),
    status: "done",
    result: String(row.summary),
    verificationNote: [
      row.reviewReceiptDigest ? `review:${row.reviewReceiptDigest}` : "review:not-applicable",
      row.integrationReceiptDigest ? `integration:${row.integrationReceiptDigest}` : "integration:not-applicable",
      `result:${row.resultDigest}`,
    ].join(" · ").slice(0, 300),
    planDigest: row.planDigest,
    planGeneration: row.planGeneration,
    sourceNodeId: row.sourceNodeId,
    sourceJobId: String(row.sourceJobId),
    sourceAttempt: row.sourceAttempt,
    sourceSteerRevision: row.sourceSteerRevision,
    workOrderRevisionDigest: row.workOrderRevisionDigest,
    reviewReceiptDigest: row.reviewReceiptDigest,
    integrationReceiptDigest: row.integrationReceiptDigest,
    repository: row.repository,
    sourceBranch: row.sourceBranch,
    sourceHeadSha: row.sourceHeadSha,
    integrationBranch: row.integrationBranch,
    integrationHeadSha: row.integrationHeadSha,
    artifactRefs: row.artifactRefs,
    resultDigest: row.resultDigest,
  };
}

/**
 * Seal one immutable, generation-bound handoff from cold execution receipts.
 * This is called by terminal mutations before a dependent can become runnable;
 * dispatch is deliberately read-only with respect to handoff authority.
 */
export async function ensureGoalNodeHandoff(ctx: any, source: any) {
  if (!source?.planParentMissionId || !source.planDigest || !source.planGeneration || !source.planNodeId
    || source.status !== "done" || source.verificationVerdict !== "pass") return null;
  const sourceAttempt = Number(source.attempt ?? 1);
  const sourceSteerRevision = Number(source.steerRevision ?? 0);
  const existing: any = await ctx.db.query("goalHandoffs")
    .withIndex("by_source_attempt", (q: any) => q.eq("sourceJobId", source._id)
      .eq("sourceAttempt", sourceAttempt).eq("planGeneration", Number(source.planGeneration))).first();
  if (existing) return existing.planDigest === source.planDigest
    && existing.sourceNodeId === source.planNodeId
    && existing.workOrderRevisionDigest === source.workOrderRevisionDigest
    && Number(existing.sourceSteerRevision) === sourceSteerRevision ? existing : null;

  const receipt: any = await ctx.db.query("workReceipts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", source._id).eq("attempt", sourceAttempt)).first();
  const executionAuthority = await readAttemptExecutionAuthority(ctx, source, sourceAttempt);
  if (!executionAuthority || !receipt || receipt.status !== "succeeded" || receipt.verification !== "pass"
    || receipt.authorityDigest !== executionAuthority.authorityDigest
    || receipt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest) return null;
  const review: any = source.reviewReceiptId ? await ctx.db.get(source.reviewReceiptId) : null;
  if (source.repo && (!review || review.jobId !== source._id || review.attempt !== sourceAttempt
    || review.receiptDigest !== source.reviewReceiptDigest || receipt.reviewReceiptDigest !== review.receiptDigest
    || review.authorityDigest !== executionAuthority.authorityDigest
    || review.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest)) return null;

  let integration: any = null;
  let terminal: any = null;
  if (source.repo && !source.readonly) {
    integration = source.integrationAttemptId ? await ctx.db.get(source.integrationAttemptId) : null;
    terminal = integration ? await ctx.db.query("integrationTerminalReceipts")
      .withIndex("by_attempt", (q: any) => q.eq("integrationAttemptId", integration._id)).first() : null;
    if (!integration || integration.jobId !== source._id || integration.workAttempt !== sourceAttempt
      || integration.status !== "integrated" || !integration.terminalReceiptDigest
      || integration.reviewReceiptDigest !== source.reviewReceiptDigest
      || integration.authorityDigest !== executionAuthority.authorityDigest
      || integration.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
      || integration.providerObservedHeadSha !== integration.preparedIntegrationHeadSha
      || !terminal || terminal.receiptDigest !== integration.terminalReceiptDigest || terminal.outcome !== "integrated"
      || terminal.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest) return null;
  }

  const summary = String(source.result ?? source.progress ?? "Verified upstream node completed")
    .trim().slice(0, GOAL_HANDOFF_SUMMARY_MAX_CHARS);
  if (!summary) return null;
  const resultDigest = await sha256Hex(summary);
  const artifactRefs = [...new Set([
    ...(Array.isArray(receipt.artifacts) ? receipt.artifacts : []),
    source.workerBranch, source.integrationBranch, integration?.preparedIntegrationHeadSha,
  ].filter((item): item is string => typeof item === "string" && item.length > 0))]
    .slice(0, GOAL_HANDOFF_ARTIFACT_MAX).map((item) => item.slice(0, 500));
  const id = await ctx.db.insert("goalHandoffs", {
    parentMissionId: source.planParentMissionId,
    planDigest: source.planDigest,
    planGeneration: Number(source.planGeneration),
    sourceNodeId: source.planNodeId,
    sourceJobId: source._id,
    sourceAttempt,
    sourceSteerRevision,
    workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
    reviewReceiptDigest: review?.receiptDigest,
    integrationReceiptDigest: terminal?.receiptDigest,
    repository: source.repo,
    sourceBranch: source.sourceBranch,
    sourceHeadSha: review?.baseSha ?? source.sourceHeadSha,
    integrationBranch: integration?.integrationBranch,
    integrationHeadSha: integration?.preparedIntegrationHeadSha,
    artifactRefs,
    resultDigest,
    summary,
    createdAt: Date.now(),
  });
  return await ctx.db.get(id);
}

/** Resolve only already-sealed handoffs; dispatch can never manufacture DAG authority. */
export async function verifiedGoalHandoffsForJob(ctx: any, target: any) {
  if (!target?.planParentMissionId || !target.planDigest || !target.planGeneration || !target.planNodeId) return null;
  const edges = await ctx.db.query("goalPlanEdges")
    .withIndex("by_target", (q: any) => q.eq("targetJobId", target._id).eq("planGeneration", Number(target.planGeneration)))
    .take(GOAL_DAG_MAX_NODES);
  if (edges.length !== (target.dependsOn ?? []).length) return null;
  const handoffs = [];
  for (const edge of edges) {
    if (edge.parentMissionId !== target.planParentMissionId || edge.planDigest !== target.planDigest
      || edge.targetNodeId !== target.planNodeId || !(target.dependsOn ?? []).includes(String(edge.sourceJobId))) return null;
    const source: any = await ctx.db.get(edge.sourceJobId);
    if (!source || source.planParentMissionId !== target.planParentMissionId || source.planDigest !== target.planDigest
      || Number(source.planGeneration) !== Number(target.planGeneration) || source.planNodeId !== edge.sourceNodeId) return null;
    const handoff: any = await ctx.db.query("goalHandoffs")
      .withIndex("by_source_attempt", (q: any) => q.eq("sourceJobId", source._id)
        .eq("sourceAttempt", Number(source.attempt ?? 1)).eq("planGeneration", Number(source.planGeneration))).first();
    if (!handoff || handoff.parentMissionId !== target.planParentMissionId
      || handoff.planDigest !== target.planDigest || Number(handoff.planGeneration) !== Number(target.planGeneration)
      || handoff.sourceNodeId !== source.planNodeId || handoff.sourceJobId !== source._id
      || Number(handoff.sourceAttempt) !== Number(source.attempt ?? 1)
      || handoff.workOrderRevisionDigest !== source.workOrderRevisionDigest
      || Number(handoff.sourceSteerRevision) !== Number(source.steerRevision ?? 0)) return null;
    handoffs.push(handoffEnvelope(handoff));
  }
  return handoffs;
}
