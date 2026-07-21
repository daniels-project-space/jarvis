/** Pure protocol guards shared by durable writers and their regression tests. */
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function completionReceiptAllowed(input: {
  result?: unknown; verificationNote?: unknown; resultDigest?: unknown; evidenceDigest?: unknown;
  reviewReceiptSignature?: unknown; reviewDiffSha256?: unknown;
}) {
  return Boolean(String(input.result ?? "").trim() && String(input.verificationNote ?? "").trim())
    && isSha256Digest(input.resultDigest)
    && isSha256Digest(input.evidenceDigest)
    && (input.reviewReceiptSignature === undefined || isSha256Digest(input.reviewReceiptSignature))
    && (input.reviewDiffSha256 === undefined || isSha256Digest(input.reviewDiffSha256));
}

export type LeaseSnapshot = { status: string; attempt: number; steerRevision?: number };

/**
 * A subscription error is not a revocation.  A recent known lease remains
 * usable only for this bounded window; callers must query once it expires.
 */
export function leaseDecision(input: {
  now: number;
  expectedAttempt: number;
  expectedSteerRevision: number;
  lease?: LeaseSnapshot | null;
  leaseObservedAt?: number;
  maxKnownAgeMs: number;
}): "running" | "paused" | "cancelled" | "steered" | "superseded" | "query" {
  if (!input.lease || !input.leaseObservedAt || input.now - input.leaseObservedAt > input.maxKnownAgeMs) return "query";
  if (input.lease.attempt !== input.expectedAttempt) return "superseded";
  if (Number(input.lease.steerRevision ?? 0) !== input.expectedSteerRevision) return "steered";
  if (input.lease.status === "running") return "running";
  if (input.lease.status === "paused") return "paused";
  if (input.lease.status === "cancelled") return "cancelled";
  return "superseded";
}

export type CausalCursor = { sequence: number; eventKey?: string };

export function appendCausalEvent(cursor: CausalCursor, eventKey: string) {
  if (cursor.eventKey === eventKey) return { cursor, duplicate: true };
  return {
    cursor: { sequence: cursor.sequence + 1, eventKey },
    event: { sequence: cursor.sequence + 1, predecessorKey: cursor.eventKey },
    duplicate: false,
  } as const;
}

export type ClaimBinding = { dispatchId?: string; workerRunId?: string; sessionId?: string };

/** Exact redelivery may replay only the binding committed by the first claim. */
export function claimDisposition(input: {
  jobStatus: string;
  jobDispatchId?: string;
  requestDispatchId: string;
  requestWorkerRunId: string;
  attempt?: ClaimBinding | null;
}): "claim" | "replay" | "fenced" {
  const worker = input.requestWorkerRunId.slice(0, 120);
  if (input.jobStatus === "running") {
    return input.jobDispatchId === input.requestDispatchId
      && input.attempt?.dispatchId === input.requestDispatchId
      && input.attempt.workerRunId === worker
      && input.attempt.sessionId === worker
      ? "replay" : "fenced";
  }
  return input.jobStatus === "dispatching" && input.jobDispatchId === input.requestDispatchId ? "claim" : "fenced";
}

export function replayEnvelope<T>(persisted: readonly T[] | undefined, current: readonly T[]): readonly T[] {
  return persisted ?? current;
}

export function shouldAdvanceAttempt(launched: boolean): boolean {
  return launched;
}
