import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
const runner = readFileSync(new URL("../src/trigger/agent-runner.ts", import.meta.url), "utf8");

describe("attempt authority regression guards", () => {
  it("recovers only an exact lost-response claim and fences competing sessions", () => {
    const claim = jobs.slice(jobs.indexOf("export const claimDispatched"), jobs.indexOf("export const rejectDispatch"));
    expect(claim).toContain('j?.status === "running"');
    expect(claim).toContain("priorAttempt?.dispatchId === a.dispatchId");
    expect(claim).toContain("priorAttempt.workerRunId === a.workerRunId.slice(0, 120)");
    expect(claim).toContain("dispatchId: a.dispatchId");
  });

  it("keeps the first runtime rollout compatible with legacy rows", () => {
    const runtime = schema.slice(schema.indexOf("jobRuntime: defineTable"), schema.indexOf("missions: defineTable"));
    expect(runtime).toContain("progressAt: v.optional(v.number())");
    expect(runtime).toContain("stallCount: v.optional(v.number())");
    expect(runtime).toContain("steerRevision: v.optional(v.number())");
    expect(runtime).toContain('.index("by_active_priority", ["active", "priority", "createdAt"])');
  });

  it("uses one active-work index and avoids attempt writes for liveness", () => {
    const active = jobs.slice(jobs.indexOf("export const active"), jobs.indexOf("export const workerRun"));
    const heartbeat = jobs.slice(jobs.indexOf("export const touchHeartbeat"), jobs.indexOf("export const checkpointAndRequeue"));
    expect(active).toContain('.withIndex("by_active_priority"');
    expect(active).not.toContain("Promise.all");
    expect(heartbeat).not.toContain("ctx.db.patch(attempt._id");
    expect(runner).toContain("api.jobs.executionLease");
    expect(runner).toContain(">= 60_000");
  });

  it("binds terminal receipts to a terminal event and concrete artifact reference", () => {
    const finalize = jobs.slice(jobs.indexOf("export const finalize"), jobs.indexOf("export const list"));
    expect(finalize).toContain("terminalEventKey");
    expect(finalize).toContain("convex://jobs/");
    expect(finalize).toContain("resultDigest");
    expect(jobs).toContain('status: running ? "steering" : row.status');
    expect(jobs).toContain('status: "needs_input"');
  });
});
