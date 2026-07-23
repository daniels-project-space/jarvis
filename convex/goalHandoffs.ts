import {
  GOAL_DAG_MAX_NODES,
  GOAL_HANDOFF_ARTIFACT_MAX,
  GOAL_HANDOFF_SUMMARY_MAX_CHARS,
} from "../src/lib/goal-dag";
import { readAttemptExecutionAuthority } from "./controlPlane";

/* eslint-disable @typescript-eslint/no-explicit-any -- Convex database contexts and additive rolling-schema rows cross a dynamic generated boundary in this isolated authority module. */

export const GOAL_HANDOFF_PROTOCOL_VERSION = 2;
export const GOAL_HANDOFF_PAYLOAD_DOMAIN = "jarvis.goal-handoff.v2";
export const GOAL_HANDOFF_WORK_RECEIPT_DOMAIN = "jarvis.goal-handoff.work-receipt.v2";
export const GOAL_HANDOFF_INTEGRATION_RECEIPT_DOMAIN = "jarvis.goal-handoff.integration-terminal.v2";
export const GOAL_HANDOFF_SUMMARY_DOMAIN = "jarvis.goal-handoff.bounded-summary.v2";

function canonicalValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
  return value;
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalGoalHandoffPayload(payload: Record<string, unknown>) {
  return JSON.stringify(canonicalValue({ domain: GOAL_HANDOFF_PAYLOAD_DOMAIN, ...payload }));
}

export async function goalHandoffPayloadDigest(payload: Record<string, unknown>) {
  return await sha256Hex(canonicalGoalHandoffPayload(payload));
}

function canonicalBinding(domain: string, binding: Record<string, unknown>) {
  return JSON.stringify(canonicalValue({ domain, ...binding }));
}

function handoffEnvelope(row: any) {
  return {
    label: String(row.sourceNodeId),
    status: "done",
    result: String(row.summary),
    verificationNote: [
      row.reviewReceiptDigest ? `review:${row.reviewReceiptDigest}` : "review:not-applicable",
      row.integrationTerminalReceiptDigest ? `integration:${row.integrationTerminalReceiptDigest}` : "integration:not-applicable",
      `result:${row.acceptedResultDigest}`,
    ].join(" · ").slice(0, 300),
    planDigest: row.planDigest,
    planGeneration: row.planGeneration,
    sourceNodeId: row.sourceNodeId,
    sourceJobId: String(row.sourceJobId),
    sourceAttempt: row.sourceAttempt,
    sourceSteerRevision: row.sourceSteerRevision,
    workOrderRevisionDigest: row.workOrderRevisionDigest,
    reviewReceiptDigest: row.reviewReceiptDigest,
    integrationReceiptDigest: row.integrationTerminalReceiptDigest,
    repository: row.repository,
    sourceBranch: row.sourceBranch,
    sourceHeadSha: row.sourceHeadSha,
    integrationBranch: row.integrationBranch,
    integrationHeadSha: row.integrationHeadSha,
    artifactRefs: row.artifactRefs,
    resultDigest: row.acceptedResultDigest,
    handoffPayloadDigest: row.handoffPayloadDigest,
  };
}

function exactFieldsMatch(existing: any, candidate: Record<string, unknown>) {
  return Object.entries(candidate).every(([key, value]) =>
    JSON.stringify(canonicalValue(existing[key])) === JSON.stringify(canonicalValue(value)));
}

/**
 * Seal one immutable, generation-bound handoff from cold execution receipts.
 * This is called by terminal mutations before a dependent can become runnable;
 * dispatch is deliberately read-only with respect to handoff authority.
 */
export async function ensureGoalNodeHandoff(ctx: any, source: any) {
  if (!source?.planParentMissionId || !source.planDigest || !source.planGeneration || !source.planNodeId
    || source.admissionProtocolVersion !== GOAL_HANDOFF_PROTOCOL_VERSION
    || source.status !== "done" || source.verificationVerdict !== "pass") return null;
  const sourceAttempt = Number(source.attempt ?? 1);
  const sourceSteerRevision = Number(source.steerRevision ?? 0);
  const planNode: any = await ctx.db.query("goalPlanNodes")
    .withIndex("by_job", (q: any) => q.eq("jobId", source._id)).first();
  if (!planNode || planNode.parentMissionId !== source.planParentMissionId
    || planNode.planDigest !== source.planDigest
    || Number(planNode.planGeneration) !== Number(source.planGeneration)
    || planNode.nodeId !== source.planNodeId) return null;
  const receipt: any = await ctx.db.query("workReceipts")
    .withIndex("by_job_attempt", (q: any) => q.eq("jobId", source._id).eq("attempt", sourceAttempt)).first();
  const executionAuthority = await readAttemptExecutionAuthority(ctx, source, sourceAttempt);
  if (!executionAuthority || !receipt || receipt.status !== "succeeded" || receipt.verification !== "pass"
    || receipt.authorityDigest !== executionAuthority.authorityDigest
    || receipt.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || receipt.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || receipt.workOrderRevision !== executionAuthority.workOrderRevision
    || receipt.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
    || receipt.canonicalProjectId !== executionAuthority.canonicalProjectId
    || receipt.repository !== executionAuthority.repository
    || typeof receipt.resultDigest !== "string" || typeof receipt.evidenceDigest !== "string"
    || typeof receipt.terminalEventKey !== "string") return null;

  const acceptedResult = String(source.result ?? "").slice(0, 4_000);
  const acceptedEvidence = String(source.verificationNote ?? "").slice(0, 1_000);
  if (!acceptedResult.trim()
    || await sha256Hex(acceptedResult) !== receipt.resultDigest
    || await sha256Hex(acceptedEvidence) !== receipt.evidenceDigest) return null;

  const review: any = source.reviewReceiptId ? await ctx.db.get(source.reviewReceiptId) : null;
  if (source.repo && (!review || review._id !== receipt.reviewReceiptId
    || review.jobId !== source._id || review.attempt !== sourceAttempt
    || review.receiptDigest !== source.reviewReceiptDigest || receipt.reviewReceiptDigest !== review.receiptDigest
    || await sha256Hex(String(review.receiptJson)) !== review.receiptDigest
    || review.authorityDigest !== executionAuthority.authorityDigest
    || review.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
    || review.workOrderRevisionId !== executionAuthority.workOrderRevisionId
    || review.workOrderRevision !== executionAuthority.workOrderRevision
    || review.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest)) return null;

  const workReceiptBinding = {
    workReceiptId: String(receipt._id),
    jobId: String(source._id),
    attempt: sourceAttempt,
    authorityDigest: executionAuthority.authorityDigest,
    schedulingBindingDigest: executionAuthority.schedulingBindingDigest,
    workOrderRevisionId: String(executionAuthority.workOrderRevisionId),
    workOrderRevision: executionAuthority.workOrderRevision,
    workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
    acceptedResultDigest: receipt.resultDigest,
    evidenceDigest: receipt.evidenceDigest,
    terminalEventKey: receipt.terminalEventKey,
    reviewReceiptId: review ? String(review._id) : null,
    reviewReceiptDigest: review?.receiptDigest ?? null,
    canonicalProjectId: executionAuthority.canonicalProjectId,
    repository: executionAuthority.repository ?? null,
    sourceBranch: executionAuthority.sourceBranch ?? null,
    sourceHeadSha: executionAuthority.sourceHeadSha ?? null,
    sourceAdmissionDigest: executionAuthority.sourceAdmissionDigest,
  };
  const workReceiptDigest = await sha256Hex(canonicalBinding(GOAL_HANDOFF_WORK_RECEIPT_DOMAIN, workReceiptBinding));

  let integration: any = null;
  let terminal: any = null;
  let integrationBindingDigest: string | undefined;
  if (source.repo && !source.readonly) {
    integration = source.integrationAttemptId ? await ctx.db.get(source.integrationAttemptId) : null;
    terminal = integration ? await ctx.db.query("integrationTerminalReceipts")
      .withIndex("by_attempt", (q: any) => q.eq("integrationAttemptId", integration._id)).first() : null;
    if (!integration || integration.jobId !== source._id || integration.workAttempt !== sourceAttempt
      || integration.status !== "integrated" || integration.outcome !== "integrated"
      || !integration.terminalReceiptDigest || !integration.preparedEffectId
      || integration.reviewReceiptId !== review?._id || integration.reviewReceiptDigest !== review?.receiptDigest
      || integration.authorityDigest !== executionAuthority.authorityDigest
      || integration.schedulingBindingDigest !== executionAuthority.schedulingBindingDigest
      || integration.workOrderRevisionId !== executionAuthority.workOrderRevisionId
      || integration.workOrderRevision !== executionAuthority.workOrderRevision
      || integration.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
      || integration.canonicalProjectId !== executionAuthority.canonicalProjectId
      || integration.repository !== executionAuthority.repository
      || integration.sourceBranch !== executionAuthority.sourceBranch
      || integration.providerObservedHeadSha !== integration.preparedIntegrationHeadSha
      || !terminal || terminal.integrationAttemptId !== integration._id
      || terminal.jobId !== source._id || terminal.receiptDigest !== integration.terminalReceiptDigest
      || terminal.outcome !== "integrated" || terminal.workOrderRevisionDigest !== executionAuthority.workOrderRevisionDigest
      || await sha256Hex(String(terminal.receiptJson)) !== terminal.receiptDigest) return null;
    const integrationBinding = {
      integrationTerminalReceiptId: String(terminal._id),
      integrationTerminalReceiptDigest: terminal.receiptDigest,
      integrationAttemptId: String(integration._id),
      integrationAttempt: integration.workAttempt,
      integrationGeneration: integration.generation,
      preparedEffectId: integration.preparedEffectId,
      outcome: integration.outcome,
      preparedIntegrationHeadSha: integration.preparedIntegrationHeadSha,
      preparedIntegrationTreeSha: integration.preparedIntegrationTreeSha,
      providerObservedHeadSha: integration.providerObservedHeadSha,
      expectedIntegrationBaseSha: integration.expectedIntegrationBaseSha,
      expectedIntegrationRefSha: integration.expectedIntegrationRefSha,
      authorityDigest: integration.authorityDigest,
      schedulingBindingDigest: integration.schedulingBindingDigest,
      workOrderRevisionId: String(integration.workOrderRevisionId),
      workOrderRevision: integration.workOrderRevision,
      workOrderRevisionDigest: integration.workOrderRevisionDigest,
      reviewReceiptId: String(integration.reviewReceiptId),
      reviewReceiptDigest: integration.reviewReceiptDigest,
      canonicalProjectId: integration.canonicalProjectId,
      repository: integration.repository,
      sourceBranch: integration.sourceBranch,
      workerBranch: integration.workerBranch,
      integrationBranch: integration.integrationBranch,
    };
    integrationBindingDigest = await sha256Hex(canonicalBinding(GOAL_HANDOFF_INTEGRATION_RECEIPT_DOMAIN, integrationBinding));
  }

  const summary = acceptedResult.trim().slice(0, GOAL_HANDOFF_SUMMARY_MAX_CHARS);
  const boundedSummaryProjectionDigest = await sha256Hex(canonicalBinding(GOAL_HANDOFF_SUMMARY_DOMAIN, {
    acceptedResultDigest: receipt.resultDigest,
    maxChars: GOAL_HANDOFF_SUMMARY_MAX_CHARS,
    summary,
  }));
  const artifactRefs = [...new Set([
    ...(Array.isArray(receipt.artifacts) ? receipt.artifacts : []),
    source.workerBranch, source.integrationBranch, integration?.preparedIntegrationHeadSha,
  ].filter((item): item is string => typeof item === "string" && item.length > 0))]
    .slice(0, GOAL_HANDOFF_ARTIFACT_MAX).map((item) => item.slice(0, 500));
  const payload = {
    parentMissionId: String(source.planParentMissionId),
    planDigest: source.planDigest,
    planGeneration: Number(source.planGeneration),
    sourceNodeId: source.planNodeId,
    sourceJobId: String(source._id),
    sourceAttempt,
    sourceSteerRevision,
    workReceiptDigest,
    integrationBindingDigest: integrationBindingDigest ?? null,
    boundedSummaryProjectionDigest,
  };
  const handoffPayloadDigest = await goalHandoffPayloadDigest(payload);
  const value = {
    handoffProtocolVersion: GOAL_HANDOFF_PROTOCOL_VERSION,
    parentMissionId: source.planParentMissionId,
    planDigest: source.planDigest,
    planGeneration: Number(source.planGeneration),
    sourceNodeId: source.planNodeId,
    sourceJobId: source._id,
    sourceAttempt,
    sourceSteerRevision,
    authorityDigest: executionAuthority.authorityDigest,
    schedulingBindingDigest: executionAuthority.schedulingBindingDigest,
    workOrderRevisionId: executionAuthority.workOrderRevisionId,
    workOrderRevision: executionAuthority.workOrderRevision,
    workOrderRevisionDigest: executionAuthority.workOrderRevisionDigest,
    workReceiptId: receipt._id,
    workReceiptDigest,
    acceptedResultDigest: receipt.resultDigest,
    evidenceDigest: receipt.evidenceDigest,
    terminalEventKey: receipt.terminalEventKey,
    reviewReceiptId: review?._id,
    reviewReceiptDigest: review?.receiptDigest,
    integrationAttemptId: integration?._id,
    integrationAttempt: integration?.workAttempt,
    integrationGeneration: integration?.generation,
    integrationEffectId: integration?.preparedEffectId,
    integrationBindingDigest,
    integrationTerminalReceiptId: terminal?._id,
    integrationTerminalReceiptDigest: terminal?.receiptDigest,
    canonicalProjectId: executionAuthority.canonicalProjectId,
    repository: source.repo,
    sourceAdmissionDigest: executionAuthority.sourceAdmissionDigest,
    sourceBranch: executionAuthority.sourceBranch,
    sourceHeadSha: executionAuthority.sourceHeadSha,
    integrationBranch: integration?.integrationBranch,
    integrationHeadSha: integration?.preparedIntegrationHeadSha,
    artifactRefs,
    acceptedResultProjectionDigest: boundedSummaryProjectionDigest,
    handoffPayloadDigest,
    // Compatibility projection. It is never terminal proof in protocol v2.
    resultDigest: receipt.resultDigest,
    summary,
  };
  const existing: any = await ctx.db.query("goalHandoffs")
    .withIndex("by_source_attempt", (q: any) => q.eq("sourceJobId", source._id)
      .eq("sourceAttempt", sourceAttempt).eq("planGeneration", Number(source.planGeneration))).first();
  if (existing) return exactFieldsMatch(existing, value) ? existing : null;
  const id = await ctx.db.insert("goalHandoffs", { ...value, createdAt: Date.now() });
  return await ctx.db.get(id);
}

export async function authoritativeGoalHandoffMatches(row: any, source: any) {
  if (!(row?.handoffProtocolVersion === GOAL_HANDOFF_PROTOCOL_VERSION
    && typeof row.handoffPayloadDigest === "string"
    && typeof row.workReceiptId === "string"
    && typeof row.workReceiptDigest === "string"
    && row.parentMissionId === source.planParentMissionId
    && row.planDigest === source.planDigest
    && Number(row.planGeneration) === Number(source.planGeneration)
    && row.sourceNodeId === source.planNodeId
    && row.sourceJobId === source._id
    && Number(row.sourceAttempt) === Number(source.attempt ?? 1)
    && Number(row.sourceSteerRevision) === Number(source.steerRevision ?? 0)
    && row.workOrderRevisionId === source.workOrderRevisionId
    && Number(row.workOrderRevision) === Number(source.workOrderRevision)
    && row.workOrderRevisionDigest === source.workOrderRevisionDigest
    && (!source.repo || row.reviewReceiptId === source.reviewReceiptId
      && row.reviewReceiptDigest === source.reviewReceiptDigest)
    && (!source.repo || source.readonly || row.integrationAttemptId === source.integrationAttemptId
      && typeof row.integrationBindingDigest === "string"
      && typeof row.integrationTerminalReceiptId === "string"
      && typeof row.integrationTerminalReceiptDigest === "string"))) return false;
  const result = String(source.result ?? "").slice(0, 4_000);
  const evidence = String(source.verificationNote ?? "").slice(0, 1_000);
  if (await sha256Hex(result) !== row.acceptedResultDigest || await sha256Hex(evidence) !== row.evidenceDigest) return false;
  return await goalHandoffPayloadDigest({
    parentMissionId: String(row.parentMissionId),
    planDigest: row.planDigest,
    planGeneration: Number(row.planGeneration),
    sourceNodeId: row.sourceNodeId,
    sourceJobId: String(row.sourceJobId),
    sourceAttempt: Number(row.sourceAttempt),
    sourceSteerRevision: Number(row.sourceSteerRevision),
    workReceiptDigest: row.workReceiptDigest,
    integrationBindingDigest: row.integrationBindingDigest ?? null,
    boundedSummaryProjectionDigest: row.acceptedResultProjectionDigest,
  }) === row.handoffPayloadDigest;
}

/** Resolve only already-sealed v2 handoffs; dispatch can never manufacture DAG authority. */
export async function verifiedGoalHandoffsForJob(ctx: any, target: any) {
  if (!target?.planParentMissionId || !target.planDigest || !target.planGeneration || !target.planNodeId
    || target.admissionProtocolVersion !== GOAL_HANDOFF_PROTOCOL_VERSION) return null;
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
    if (!await authoritativeGoalHandoffMatches(handoff, source)) return null;
    // Re-read and re-hash every cold receipt binding. Because an existing row
    // was point-read first, this cannot manufacture authority during dispatch;
    // it only proves the stored row is the exact idempotent seal candidate.
    const resealed = await ensureGoalNodeHandoff(ctx, source);
    if (!resealed || resealed._id !== handoff._id) return null;
    handoffs.push(handoffEnvelope(handoff));
  }
  return handoffs;
}
