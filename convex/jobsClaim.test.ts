import { afterEach, describe, expect, it } from "vitest";
import { claimDispatched } from "./jobs";

type Row = Record<string, any>;

function claimHarness() {
  const jobs = new Map<string, Row>();
  const attempts: Row[] = [];
  const events: Row[] = [];
  const runtime: Row[] = [];
  let id = 0;
  const rows = (table: string) => table === "jobs" ? [...jobs.values()] : table === "workAttempts" ? attempts : table === "workEvents" ? events : table === "jobRuntime" ? runtime : [];
  const matches = (table: string, predicates: Array<{ field: string; value: unknown }>) => rows(table).filter((row) => predicates.every((p) => row[p.field] === p.value));
  const db: any = {
    get: async (key: string) => jobs.get(String(key)) ?? rows("workAttempts").find((r) => r._id === key) ?? rows("jobRuntime").find((r) => r._id === key) ?? null,
    normalizeId: (_table: string, key: string) => jobs.has(String(key)) ? key : null,
    insert: async (table: string, value: Row) => {
      const _id = `${table}-${++id}`;
      const record = { ...value, _id };
      if (table === "jobs") jobs.set(_id, record); else if (table === "workAttempts") attempts.push(record); else if (table === "workEvents") events.push(record); else if (table === "jobRuntime") runtime.push(record);
      return _id;
    },
    patch: async (key: string, patch: Row) => {
      const row = await db.get(key);
      if (!row) throw new Error(`missing ${key}`);
      Object.assign(row, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    },
    replace: async (key: string, value: Row) => { const row = await db.get(key); Object.assign(row, value); },
    query: (table: string) => ({
      withIndex: (_name: string, callback: (q: any) => any) => {
        const predicates: any[] = [];
        callback({ eq: (field: string, value: unknown) => (predicates.push({ field, value }), { eq: (f: string, v: unknown) => (predicates.push({ field: f, value: v }), {}) }) });
        const selected = () => matches(table, predicates);
        return { first: async () => selected()[0] ?? null, take: async (n: number) => selected().slice(0, n), order: () => ({ take: async (n: number) => selected().slice(0, n) }) };
      },
    }),
  };
  const job: Row = { _id: "job-1", task: "work", status: "dispatching", dispatchId: "dispatch-1", dispatchLeaseUntil: Date.now() + 60_000, attempt: 1, maxAttempts: 3, priority: 50, createdAt: 1, dependsOn: ["dep-1"] };
  const dep: Row = { _id: "dep-1", task: "dependency", label: "Dependency", status: "done", result: "stable evidence", verificationNote: "checked", createdAt: 0 };
  jobs.set(job._id, job); jobs.set(dep._id, dep);
  attempts.push({ _id: "attempt-1", jobId: "job-1", attempt: 1, status: "dispatching", dispatchId: "dispatch-1", lastEventSeq: 1, livenessAt: 1, progressAt: 1, lastEventAt: 1, createdAt: 1 });
  return { ctx: { db }, job, attempts, events, jobs };
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
    expect(h.job.status).toBe("running");
    expect(h.attempts[0]).toMatchObject({ status: "running", dispatchId: "dispatch-1", workerRunId: "run-a", sessionId: "run-a" });
    h.jobs.get("dep-1")!.result = "mutated after claim";
    const replay = await claim(h.ctx, { jobId: "job-1", dispatchId: "dispatch-1", workerRunId: "run-a", workerToken: "test-worker" });
    expect(replay).toEqual(first);
    expect(await claim(h.ctx, { jobId: "job-1", dispatchId: "dispatch-1", workerRunId: "run-b", workerToken: "test-worker" })).toBeNull();
    expect(h.events.map((event) => event.sequence)).toEqual([1]);
  });
});
