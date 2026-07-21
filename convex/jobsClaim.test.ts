import { afterEach, describe, expect, it } from "vitest";
import { claimDispatched } from "./jobs";

type Row = Record<string, any>;

function claimHarness() {
  const jobs = new Map<string, Row>();
  const attempts: Row[] = [];
  const events: Row[] = [];
  const runtime: Row[] = [];
  const deliveryAttempts: Row[] = [];
  let id = 0;
  const rows = (table: string) => table === "jobs" ? [...jobs.values()] : table === "workAttempts" ? attempts : table === "workEvents" ? events : table === "jobRuntime" ? runtime : table === "deliveryAttempts" ? deliveryAttempts : [];
  const matches = (table: string, predicates: Array<{ field: string; value: unknown }>) => rows(table).filter((row) => predicates.every((p) => row[p.field] === p.value));
  const db: any = {
    // Convex returns immutable document snapshots. Keep this narrow harness
    // honest: callers must re-read after patch rather than observe mutation.
    get: async (key: string) => {
      const found = jobs.get(String(key)) ?? rows("workAttempts").find((r) => r._id === key) ?? rows("jobRuntime").find((r) => r._id === key) ?? rows("deliveryAttempts").find((r) => r._id === key) ?? null;
      return found ? { ...found } : null;
    },
    normalizeId: (_table: string, key: string) => jobs.has(String(key)) ? key : null,
    insert: async (table: string, value: Row) => {
      const _id = `${table}-${++id}`;
      const record = { ...value, _id };
      if (table === "jobs") jobs.set(_id, record); else if (table === "workAttempts") attempts.push(record); else if (table === "workEvents") events.push(record); else if (table === "jobRuntime") runtime.push(record); else if (table === "deliveryAttempts") deliveryAttempts.push(record);
      return _id;
    },
    patch: async (key: string, patch: Row) => {
      const row = jobs.get(String(key)) ?? rows("workAttempts").find((r) => r._id === key) ?? rows("jobRuntime").find((r) => r._id === key) ?? rows("deliveryAttempts").find((r) => r._id === key);
      if (!row) throw new Error(`missing ${key}`);
      Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    },
    replace: async (key: string, value: Row) => {
      const row = jobs.get(String(key)) ?? rows("workAttempts").find((r) => r._id === key) ?? rows("jobRuntime").find((r) => r._id === key) ?? rows("deliveryAttempts").find((r) => r._id === key);
      if (!row) throw new Error(`missing ${key}`);
      Object.assign(row, value);
    },
    query: (table: string) => ({
      withIndex: (_name: string, callback: (q: any) => any) => {
        const predicates: any[] = [];
        const query = { eq: (field: string, value: unknown) => { predicates.push({ field, value }); return query; } };
        callback(query);
        const selected = () => matches(table, predicates);
        return { first: async () => selected()[0] ?? null, take: async (n: number) => selected().slice(0, n), order: () => ({ take: async (n: number) => selected().slice(0, n) }) };
      },
    }),
  };
  const job: Row = { _id: "job-1", task: "work", status: "dispatching", dispatchId: "dispatch-1", dispatchLeaseUntil: Date.now() + 60_000, attempt: 1, maxAttempts: 3, priority: 50, createdAt: 1, dependsOn: ["dep-1"] };
  const dep: Row = { _id: "dep-1", task: "dependency", label: "Dependency", status: "done", result: "stable evidence", verificationNote: "checked", createdAt: 0 };
  jobs.set(job._id, job); jobs.set(dep._id, dep);
  attempts.push({ _id: "attempt-1", jobId: "job-1", attempt: 1, status: "dispatching", dispatchId: "dispatch-1", lastEventSeq: 1, livenessAt: 1, progressAt: 1, lastEventAt: 1, createdAt: 1 });
  return { ctx: { db }, job, attempts, events, jobs, deliveryAttempts };
}

const previousToken = process.env.JARVIS_WORKER_TOKEN;
afterEach(() => { process.env.JARVIS_WORKER_TOKEN = previousToken; });

describe("claimDispatched handler", () => {
  it("atomically binds an exact claim envelope and replays it without rereading upstream work", async () => {
    process.env.JARVIS_WORKER_TOKEN = "test-worker";
    const h = claimHarness();
    const claim = (claimDispatched as any)._handler;
    const first = await claim(h.ctx, { jobId: "job-1", dispatchId: "dispatch-1", workerRunId: "run-a", workerToken: "test-worker" });
    expect(first.upstreamEvidence).toEqual([{ label: "Dependency", status: "done", result: "stable evidence", verificationNote: "checked" }]);
    expect(h.jobs.get("job-1")?.status).toBe("running");
    expect(h.attempts[0]).toMatchObject({ status: "running", dispatchId: "dispatch-1", workerRunId: "run-a", sessionId: "run-a" });
    h.jobs.get("dep-1")!.result = "mutated after claim";
    const replay = await claim(h.ctx, { jobId: "job-1", dispatchId: "dispatch-1", workerRunId: "run-a", workerToken: "test-worker" });
    expect(replay).toEqual(first);
    expect(await claim(h.ctx, { jobId: "job-1", dispatchId: "dispatch-1", workerRunId: "run-b", workerToken: "test-worker" })).toBeNull();
    expect(h.events.map((event) => event.sequence)).toEqual([1]);
  });

  it("binds a delivery continuation to one generation/run and fences a competing controller", async () => {
    process.env.JARVIS_WORKER_TOKEN = "test-worker";
    const h = claimHarness();
    Object.assign(h.job, {
      status: "dispatching", dispatchId: "delivery-dispatch", attempt: 1,
      verificationVerdict: "pass", reviewReceiptId: "receipt-1", reviewReceiptDigest: "digest",
      branch: "jarvis/verified", deliveryGeneration: 7,
    });
    Object.assign(h.attempts[0], { status: "checkpointed", workerRunId: "specialist-run", upstreamEvidence: [] });
    const claim = (claimDispatched as any)._handler;
    const first = await claim(h.ctx, { jobId: "job-1", dispatchId: "delivery-dispatch", workerRunId: "controller-a", workerToken: "test-worker" });
    expect(first).toMatchObject({ sourceWorkAttempt: 1, deliveryGeneration: 7, deliveryRunId: "controller-a" });
    expect(h.deliveryAttempts).toHaveLength(1);
    expect(h.deliveryAttempts[0]).toMatchObject({ sourceWorkAttempt: 1, generation: 7, dispatchId: "delivery-dispatch", deliveryRunId: "controller-a", status: "running" });
    expect(await claim(h.ctx, { jobId: "job-1", dispatchId: "delivery-dispatch", workerRunId: "controller-b", workerToken: "test-worker" })).toBeNull();
  });

  it("claims an already-allocated cold delivery generation once, then replays its complete envelope", async () => {
    process.env.JARVIS_WORKER_TOKEN = "test-worker";
    const h = claimHarness();
    Object.assign(h.job, {
      status: "dispatching", dispatchId: "delivery-dispatch", attempt: 1,
      verificationVerdict: "pass", reviewReceiptId: "receipt-1", reviewReceiptDigest: "digest",
      deliveryGeneration: 1, activeDeliveryAttemptId: "delivery-1",
    });
    Object.assign(h.attempts[0], {
      status: "done", workerRunId: "specialist-run", upstreamEvidence: [{ label: "Dependency", status: "done", result: "frozen", verificationNote: "reviewed" }], completedAt: 1,
    });
    h.deliveryAttempts.push({ _id: "delivery-1", jobId: "job-1", sourceWorkAttempt: 1, generation: 1, policy: "manual", status: "checkpointed", heartbeatAt: 1, retries: 0, cumulativeRetries: 0, currentStep: "queued" });
    const claim = (claimDispatched as any)._handler;
    const first = await claim(h.ctx, { jobId: "job-1", dispatchId: "delivery-dispatch", workerRunId: "controller-a", workerToken: "test-worker" });
    expect(h.deliveryAttempts[0]).toMatchObject({ status: "running", dispatchId: "delivery-dispatch", deliveryRunId: "controller-a", currentStep: "preflight" });
    expect(await claim(h.ctx, { jobId: "job-1", dispatchId: "delivery-dispatch", workerRunId: "controller-a", workerToken: "test-worker" })).toEqual(first);
    expect(await claim(h.ctx, { jobId: "job-1", dispatchId: "delivery-dispatch", workerRunId: "controller-b", workerToken: "test-worker" })).toBeNull();
  });
});
