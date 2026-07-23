import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { readAttemptExecutionAuthority } from "./controlPlane";
import { sha256Hex } from "../src/lib/source-admission";
import { redactSensitiveText } from "../src/lib/secret-redaction";

export const WORK_RECEIPT_PROTOCOL_VERSION = 2 as const;

export type TerminalWorkStatus =
  | "succeeded"
  | "failed"
  | "needs_input"
  | "cancelled";

export type RecoveryDisposition =
  | "none"
  | "retryable"
  | "remediable"
  | "needs_input"
  | "operator_stop";

export type TerminalWorkReceiptInput = {
  status: TerminalWorkStatus;
  terminalCode: string;
  recoveryDisposition: RecoveryDisposition;
  acceptanceEvidence?: readonly string[];
  artifacts?: readonly string[];
  verification: string;
  deliveryOutcome?: string;
  terminalEventKey?: string;
  result?: string;
  evidence?: string;
  reviewReceiptSignature?: string;
  reviewDiffSha256?: string;
  reviewReceiptId?: Id<"reviewReceipts">;
  reviewReceiptDigest?: string;
};

type ReceiptContext = Pick<MutationCtx, "db">;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Terminal receipt contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Terminal receipt contains an unsupported value");
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function boundedRedactedList(
  values: readonly string[] | undefined,
  maximumItems: number,
  maximumCharacters: number,
): string[] {
  return (values ?? [])
    .slice(0, maximumItems)
    .map((value) => redactSensitiveText(String(value)).trim().slice(0, maximumCharacters))
    .filter(Boolean);
}

function receiptDigestPayload(receipt: {
  protocolVersion?: number;
  jobId: Id<"jobs">;
  attempt: number;
  status: string;
  receiptDigest?: string;
  terminalCode?: string;
  recoveryDisposition?: string;
  observedInputRevision?: number;
  authorityDigest?: string;
  schedulingBindingDigest?: string;
  workOrderRevisionId?: Id<"workOrderRevisions">;
  workOrderRevision?: number;
  workOrderRevisionDigest?: string;
  canonicalProjectId?: string;
  repository?: string;
  acceptanceEvidence: string[];
  artifacts: string[];
  verification: string;
  deliveryOutcome?: string;
  terminalEventKey?: string;
  resultDigest?: string;
  evidenceDigest?: string;
  reviewReceiptSignature?: string;
  reviewDiffSha256?: string;
  reviewReceiptId?: Id<"reviewReceipts">;
  reviewReceiptDigest?: string;
}) {
  return {
    protocolVersion: receipt.protocolVersion ?? null,
    jobId: String(receipt.jobId),
    attempt: receipt.attempt,
    status: receipt.status,
    terminalCode: receipt.terminalCode ?? null,
    recoveryDisposition: receipt.recoveryDisposition ?? null,
    observedInputRevision: receipt.observedInputRevision ?? null,
    authorityDigest: receipt.authorityDigest ?? null,
    schedulingBindingDigest: receipt.schedulingBindingDigest ?? null,
    workOrderRevisionId: receipt.workOrderRevisionId
      ? String(receipt.workOrderRevisionId)
      : null,
    workOrderRevision: receipt.workOrderRevision ?? null,
    workOrderRevisionDigest: receipt.workOrderRevisionDigest ?? null,
    canonicalProjectId: receipt.canonicalProjectId ?? null,
    repository: receipt.repository ?? null,
    acceptanceEvidence: receipt.acceptanceEvidence,
    artifacts: receipt.artifacts,
    verification: receipt.verification,
    deliveryOutcome: receipt.deliveryOutcome ?? null,
    terminalEventKey: receipt.terminalEventKey ?? null,
    resultDigest: receipt.resultDigest ?? null,
    evidenceDigest: receipt.evidenceDigest ?? null,
    reviewReceiptSignature: receipt.reviewReceiptSignature ?? null,
    reviewDiffSha256: receipt.reviewDiffSha256 ?? null,
    reviewReceiptId: receipt.reviewReceiptId
      ? String(receipt.reviewReceiptId)
      : null,
    reviewReceiptDigest: receipt.reviewReceiptDigest ?? null,
  };
}

export async function terminalWorkReceiptDigest(
  receipt: Parameters<typeof receiptDigestPayload>[0],
): Promise<string> {
  return await sha256Hex(canonicalJson(receiptDigestPayload(receipt)));
}

function assertTerminalClassification(input: TerminalWorkReceiptInput): void {
  if (!/^[a-z][a-z0-9_:-]{0,79}$/.test(input.terminalCode)) {
    throw new Error("terminalCode has an invalid format");
  }
  const valid =
    (input.status === "succeeded"
      && input.verification === "pass"
      && input.recoveryDisposition === "none")
    || (input.status === "failed"
      && ["retryable", "remediable", "operator_stop"].includes(
        input.recoveryDisposition,
      ))
    || (input.status === "needs_input"
      && input.recoveryDisposition === "needs_input")
    || (input.status === "cancelled"
      && input.recoveryDisposition === "operator_stop");
  if (!valid) {
    throw new Error("Terminal receipt status and recovery disposition conflict");
  }
}

async function observedSupervisorInputRevision(
  ctx: ReceiptContext,
  job: Doc<"jobs">,
): Promise<number | undefined> {
  if (
    typeof job.missionId !== "string"
    || typeof job.supervisorDecisionKey !== "string"
    || !Number.isSafeInteger(job.supervisorEpoch)
    || !Number.isSafeInteger(job.supervisorJobOrdinal)
  ) {
    return undefined;
  }
  const missionId = ctx.db.normalizeId("missions", job.missionId);
  if (!missionId) {
    throw new Error("Supervisor terminal receipt has an invalid mission id");
  }
  const states = await ctx.db
    .query("missionSupervisorState")
    .withIndex("by_mission", (q) => q.eq("missionId", missionId))
    .take(2);
  if (states.length !== 1 || !Number.isSafeInteger(states[0].inputRevision)) {
    throw new Error("Supervisor terminal receipt requires one input revision");
  }
  return states[0].inputRevision;
}

/**
 * Insert the one immutable terminal receipt for an exact admitted attempt.
 * All authority and digest fields are derived inside the Convex transaction.
 */
export async function insertTerminalWorkReceipt(
  ctx: ReceiptContext,
  job: Doc<"jobs">,
  attempt: number,
  input: TerminalWorkReceiptInput,
  now = Date.now(),
): Promise<{
  receiptId: Id<"workReceipts">;
  receiptDigest: string;
  replayed: boolean;
}> {
  assertTerminalClassification(input);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt !== (job.attempt ?? 1)) {
    throw new Error("Terminal receipt attempt is not current");
  }
  const authority = await readAttemptExecutionAuthority(ctx, job, attempt);
  if (!authority) {
    throw new Error("Terminal receipt requires exact execution authority");
  }
  const result = String(input.result ?? "").slice(0, 4_000);
  const evidence = String(input.evidence ?? "").slice(0, 1_000);
  const observedInputRevision = await observedSupervisorInputRevision(ctx, job);
  const receipt = {
    protocolVersion: WORK_RECEIPT_PROTOCOL_VERSION,
    jobId: job._id,
    attempt,
    terminalCode: input.terminalCode,
    recoveryDisposition: input.recoveryDisposition,
    observedInputRevision,
    authorityDigest: authority.authorityDigest,
    schedulingBindingDigest: authority.schedulingBindingDigest,
    workOrderRevisionId: authority.workOrderRevisionId,
    workOrderRevision: authority.workOrderRevision,
    workOrderRevisionDigest: authority.workOrderRevisionDigest,
    canonicalProjectId: authority.canonicalProjectId,
    repository: authority.repository,
    status: input.status,
    acceptanceEvidence: boundedRedactedList(
      input.acceptanceEvidence,
      8,
      1_000,
    ),
    artifacts: boundedRedactedList(input.artifacts, 8, 1_000),
    verification: boundedText(input.verification, 80) ?? "unavailable",
    deliveryOutcome: boundedText(input.deliveryOutcome, 80),
    terminalEventKey: boundedText(input.terminalEventKey, 240),
    resultDigest: await sha256Hex(result),
    evidenceDigest: await sha256Hex(evidence),
    reviewReceiptSignature: boundedText(input.reviewReceiptSignature, 500),
    reviewDiffSha256: boundedText(input.reviewDiffSha256, 64),
    reviewReceiptId: input.reviewReceiptId,
    reviewReceiptDigest: boundedText(input.reviewReceiptDigest, 64),
    createdAt: now,
  };
  const receiptDigest = await terminalWorkReceiptDigest(receipt);
  const existing = await ctx.db
    .query("workReceipts")
    .withIndex("by_job_attempt", (q) =>
      q.eq("jobId", job._id).eq("attempt", attempt)
    )
    .take(2);
  if (existing.length > 1) {
    throw new Error("Terminal receipt authority is ambiguous");
  }
  if (existing[0]) {
    const exactDigest = await terminalWorkReceiptDigest(existing[0]);
    if (
      existing[0].protocolVersion !== WORK_RECEIPT_PROTOCOL_VERSION
      || existing[0].receiptDigest !== exactDigest
      || exactDigest !== receiptDigest
    ) {
      throw new Error("Terminal receipt conflicts with immutable authority");
    }
    return {
      receiptId: existing[0]._id,
      receiptDigest,
      replayed: true,
    };
  }
  const receiptId = await ctx.db.insert("workReceipts", {
    ...receipt,
    receiptDigest,
  });
  return { receiptId, receiptDigest, replayed: false };
}

export async function insertFreshTerminalWorkReceipt(
  ctx: ReceiptContext,
  job: Doc<"jobs">,
  attempt: number,
  input: TerminalWorkReceiptInput,
  now = Date.now(),
): Promise<{ receiptId: Id<"workReceipts">; receiptDigest: string }> {
  const receipt = await insertTerminalWorkReceipt(
    ctx,
    job,
    attempt,
    input,
    now,
  );
  if (receipt.replayed) {
    throw new Error(
      "Terminal receipt exists before terminal job transition",
    );
  }
  return receipt;
}

function receiptStatusMatchesJob(
  jobStatus: string,
  receiptStatus: string,
): boolean {
  return (jobStatus === "done" && receiptStatus === "succeeded")
    || (jobStatus === "error" && receiptStatus === "failed")
    || (jobStatus === "needs_input" && receiptStatus === "needs_input")
    || (jobStatus === "cancelled" && receiptStatus === "cancelled");
}

/**
 * Resolve and re-hash one current terminal receipt. Recovery callers receive
 * null for legacy, ambiguous, stale-attempt, or substituted authority.
 */
export async function exactTerminalWorkReceipt(
  ctx: ReceiptContext,
  job: Doc<"jobs">,
): Promise<{
  receipt: Doc<"workReceipts">;
  authority: NonNullable<Awaited<ReturnType<typeof readAttemptExecutionAuthority>>>;
} | null> {
  const attempt = Number(job.attempt ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  const [authority, receipts] = await Promise.all([
    readAttemptExecutionAuthority(ctx, job, attempt),
    ctx.db
      .query("workReceipts")
      .withIndex("by_job_attempt", (q) =>
        q.eq("jobId", job._id).eq("attempt", attempt)
      )
      .take(2),
  ]);
  if (!authority || receipts.length !== 1) return null;
  const receipt = receipts[0];
  if (
    receipt.protocolVersion !== WORK_RECEIPT_PROTOCOL_VERSION
    || typeof receipt.receiptDigest !== "string"
    || receipt.receiptDigest !== await terminalWorkReceiptDigest(receipt)
    || receipt.authorityDigest !== authority.authorityDigest
    || receipt.schedulingBindingDigest !== authority.schedulingBindingDigest
    || receipt.workOrderRevisionId !== authority.workOrderRevisionId
    || receipt.workOrderRevision !== authority.workOrderRevision
    || receipt.workOrderRevisionDigest !== authority.workOrderRevisionDigest
    || receipt.canonicalProjectId !== authority.canonicalProjectId
    || receipt.repository !== authority.repository
    || !receiptStatusMatchesJob(job.status, receipt.status)
  ) {
    return null;
  }
  return { receipt, authority };
}
