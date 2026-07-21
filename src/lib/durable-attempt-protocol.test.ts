import { describe, expect, it } from "vitest";
import { appendCausalEvent, claimDisposition, completionReceiptAllowed, isSha256Digest, leaseDecision, replayEnvelope, shouldAdvanceAttempt } from "./durable-attempt-protocol";

describe("durable attempt protocol", () => {
  it("replays only the complete exact binding and fences competing workers", () => {
    const binding = { dispatchId: "d1", workerRunId: "run-a", sessionId: "run-a" };
    expect(claimDisposition({ jobStatus: "dispatching", jobDispatchId: "d1", requestDispatchId: "d1", requestWorkerRunId: "run-a", attempt: binding })).toBe("claim");
    expect(claimDisposition({ jobStatus: "running", jobDispatchId: "d1", requestDispatchId: "d1", requestWorkerRunId: "run-a", attempt: binding })).toBe("replay");
    expect(claimDisposition({ jobStatus: "running", jobDispatchId: "d1", requestDispatchId: "d1", requestWorkerRunId: "run-b", attempt: binding })).toBe("fenced");
    expect(claimDisposition({ jobStatus: "running", jobDispatchId: "d1", requestDispatchId: "d2", requestWorkerRunId: "run-a", attempt: binding })).toBe("fenced");
    expect(replayEnvelope(["upstream-at-claim"], ["upstream-added-later"])).toEqual(["upstream-at-claim"]);
  });

  it("serializes queue through terminal evidence and deduplicates replay", () => {
    let cursor = { sequence: 0 };
    const events = ["queued", "dispatched", "started", "progress", "done"].map((key) => {
      const next = appendCausalEvent(cursor, key);
      cursor = next.cursor;
      return next.event!;
    });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((event) => event.predecessorKey)).toEqual([undefined, "queued", "dispatched", "started", "progress"]);
    expect(appendCausalEvent(cursor, "done").duplicate).toBe(true);
  });

  it("does not consume an execution attempt before a launch", () => {
    expect(shouldAdvanceAttempt(false)).toBe(false);
    expect(shouldAdvanceAttempt(true)).toBe(true);
  });

  it("accepts only lowercase SHA-256 completion evidence", () => {
    expect(isSha256Digest("a".repeat(64))).toBe(true);
    expect(isSha256Digest("A".repeat(64))).toBe(false);
    expect(isSha256Digest("fnv-123")).toBe(false);
    const good = { result: "done", verificationNote: "checked", resultDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), reviewReceiptSignature: "c".repeat(64), reviewDiffSha256: "d".repeat(64) };
    expect(completionReceiptAllowed(good)).toBe(true);
    expect(completionReceiptAllowed({ ...good, resultDigest: `${"a".repeat(63)}!` })).toBe(false);
    expect(completionReceiptAllowed({ ...good, reviewDiffSha256: "tampered" })).toBe(false);
  });

  it("uses a bounded cached lease, then requires one fail-safe query", () => {
    const input = { expectedAttempt: 3, expectedSteerRevision: 1, lease: { status: "running", attempt: 3, steerRevision: 1 }, leaseObservedAt: 1_000, maxKnownAgeMs: 30_000 };
    expect(leaseDecision({ ...input, now: 20_000 })).toBe("running");
    expect(leaseDecision({ ...input, now: 31_001 })).toBe("query");
    expect(leaseDecision({ ...input, now: 20_000, lease: { status: "running", attempt: 3, steerRevision: 2 } })).toBe("steered");
  });
});
