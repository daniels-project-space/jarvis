import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_CANDIDATE_LIMIT,
  FLEET_MAX_EDGES,
  FLEET_MAX_NODES,
  buildFleetSnapshot,
  isUserRelevantWork,
  selectRelevantWork,
  snapshot,
} from "./commandCenter";

const threadId = "thread-current";

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-a", task: "Implement the requested surface", label: "Paul · fleet surface",
    status: "running", visibility: "conversation", originThreadId: threadId,
    stage: "testing", percent: 64, progress: "Running focused tests", progressAt: 120,
    priority: 80, createdAt: 100, active: true, agentId: "paul", model: "terra",
    reasoningEffort: "high", attempt: 1, maxAttempts: 12, steerRevision: 0,
    ...overrides,
  };
}

function planNodes(count = FLEET_MAX_NODES) {
  return Array.from({ length: count }, (_, index) => ({
    nodeId: String.fromCharCode(97 + index), jobId: `job-${String.fromCharCode(97 + index)}`,
    label: `Node ${String.fromCharCode(65 + index)}`, agentId: index % 2 ? "atlas" : "paul",
    repository: index < 4 ? "daniels-project-space/jarvis" : "daniels-project-space/project-hub",
    dependencyCount: index,
  }));
}

function completeEdges(count = FLEET_MAX_NODES) {
  const nodes = planNodes(count);
  return nodes.flatMap((target, targetIndex) => nodes.slice(0, targetIndex).map((source) => ({
    edgeId: `${source.nodeId}->${target.nodeId}`, sourceNodeId: source.nodeId, targetNodeId: target.nodeId,
    sourceJobId: source.jobId, targetJobId: target.jobId,
  })));
}

function activities(count = FLEET_MAX_NODES) {
  return planNodes(count).map((node, index) => runtime({
    jobId: node.jobId, planNodeId: node.nodeId, status: index === 0 ? "running" : "pending",
    label: node.label, agentId: node.agentId, dependsOn: planNodes(count).slice(0, index).map((item) => item.jobId),
  }));
}

describe("commandCenter relevance and bounded projection", () => {
  it.each([
    { label: "Cloud health audit" },
    { task: "Run the lease reaper" },
    { stage: "control-plane migration" },
    { label: "nightly cron job" },
    { task: "background monitor sweep" },
    { agentId: "execution reaper" },
    { visibility: "system" },
    { originThreadId: "another-thread" },
  ])("excludes routine or out-of-thread work %#", (overrides) => {
    expect(isUserRelevantWork(runtime(overrides), threadId)).toBe(false);
  });

  it.each(["pending", "dispatching", "running", "paused", "stalled", "needs_input", "awaiting_approval", "steering"])("includes user-relevant %s work", (status) => {
    expect(isUserRelevantWork(runtime({ status }), threadId)).toBe(true);
  });

  it("prioritizes Daniel attention before runtime priority", () => {
    const rows = selectRelevantWork([
      runtime({ jobId: "running", priority: 100 }),
      runtime({ jobId: "paused", status: "paused", priority: 10 }),
      runtime({ jobId: "input", status: "needs_input", priority: 1 }),
    ], threadId);
    expect(rows.map((row) => row.jobId)).toEqual(["input", "paused", "running"]);
  });

  it("accepts exactly 8 nodes and 28 edges, then rejects either overflow", () => {
    const input = { threadId, activeRows: [runtime()], nodes: planNodes(), edges: completeEdges(), activities: activities() };
    const projected = buildFleetSnapshot(input);
    expect(projected.fleet?.nodes).toHaveLength(8);
    expect(projected.fleet?.edges).toHaveLength(28);
    expect(() => buildFleetSnapshot({ ...input, nodes: planNodes(9) })).toThrow("8 nodes");
    expect(() => buildFleetSnapshot({ ...input, edges: [...completeEdges(), { edgeId: "overflow", sourceNodeId: "a", targetNodeId: "b" }] })).toThrow("28 edges");
  });

  it("keeps topological DAG order stable across persisted row order", () => {
    const nodes = planNodes(4);
    const edges = [
      { edgeId: "a->c", sourceNodeId: "a", targetNodeId: "c", sourceJobId: "job-a", targetJobId: "job-c" },
      { edgeId: "b->c", sourceNodeId: "b", targetNodeId: "c", sourceJobId: "job-b", targetJobId: "job-c" },
      { edgeId: "c->d", sourceNodeId: "c", targetNodeId: "d", sourceJobId: "job-c", targetJobId: "job-d" },
    ];
    const one = buildFleetSnapshot({ threadId, activeRows: [runtime()], nodes: [nodes[3], nodes[2], nodes[1], nodes[0]], edges: [...edges].reverse(), activities: activities(4) });
    const two = buildFleetSnapshot({ threadId, activeRows: [runtime()], nodes, edges, activities: activities(4) });
    expect(one.fleet?.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(one.fleet?.nodes.map((node) => node.id)).toEqual(two.fleet?.nodes.map((node) => node.id));
    expect(one.fleet?.edges.map((edge) => edge.id)).toEqual(["a->c", "b->c", "c->d"]);
  });

  it("projects typed handoff, recovery, integration, worker identity and honest controls without cold bytes", () => {
    const result = buildFleetSnapshot({
      threadId, activeRows: [runtime({ status: "needs_input" })],
      mission: { missionId: "mission-1", goal: "Ship one surface", mode: "goal", status: "needs_input", phase: "blocked", percent: 62, planDigest: "digest", planGeneration: 3 },
      nodes: planNodes(2), edges: completeEdges(2),
      activities: [
        runtime({ jobId: "job-a", status: "done", deliveryStatus: "merged", attempt: 2, steerRevision: 1, workerRuntime: "trigger" }),
        runtime({ jobId: "job-b", status: "needs_input", integrationState: "needs_attention", stallReason: "Merge conflict needs a decision", approvalRequired: true, approvalStatus: "pending", risk: "high", task: "x".repeat(1000), log: "private", checkpoint: "private" }),
      ],
      handoffs: [{ sourceJobId: "job-a", sourceAttempt: 2, sourceSteerRevision: 1, planDigest: "digest" }],
    });
    expect(result.active).toMatchObject({ needsDaniel: true, extraCount: 0 });
    expect(result.fleet).toMatchObject({ planDigest: "digest", planGeneration: 3, attentionCount: 1 });
    expect(result.fleet?.edges[0].readiness).toBe("delivered");
    expect(result.fleet?.nodes[0]).toMatchObject({ attempt: 2, workerRuntime: "trigger", mergeState: "merged" });
    expect(result.fleet?.nodes[1]).toMatchObject({ state: "needs_input", recoverySummary: "Merge conflict needs a decision" });
    expect(result.fleet?.nodes[1].controls).not.toContain("approve");
    expect(result.fleet?.nodes[1]).not.toHaveProperty("task");
    expect(result.fleet?.nodes[1]).not.toHaveProperty("log");
    expect(result.fleet?.nodes[1]).not.toHaveProperty("checkpoint");
  });

  it("shows approve/decline only for a persisted consequential gate", () => {
    const result = buildFleetSnapshot({
      threadId, activeRows: [runtime({ status: "awaiting_approval", approvalRequired: true, approvalStatus: "pending", risk: "consequential", deliveryMode: "manual" })],
    });
    expect(result.fleet?.nodes[0].controls).toEqual(expect.arrayContaining(["approve", "decline"]));
  });
});

describe("commandCenter.snapshot indexed IO", () => {
  it("defines the two exact hot indexes", () => {
    const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
    const jobRuntime = schema.slice(schema.indexOf("jobRuntime: defineTable"), schema.indexOf("missions: defineTable"));
    expect(jobRuntime).toContain('.index("by_thread_visibility_active_priority", ["originThreadId", "visibility", "active", "priority", "createdAt"])');
    expect(jobRuntime).toContain('.index("by_plan_parent_generation_node", ["planParentMissionId", "planGeneration", "planNodeId"])');
  });

  it("uses six bounded indexed reads for an exact persisted GoalPlan", async () => {
    const reads: Array<{ table: string; index?: string; equalities: Record<string, unknown>; limit?: number; first?: boolean; order?: string }> = [];
    const primary = runtime({ planParentMissionId: "mission-1" });
    const responses: Record<string, any[]> = {
      jobRuntime: [primary], goalPlanNodes: planNodes(2), goalPlanEdges: completeEdges(2),
      goalHandoffs: [],
    };
    const ctx = {
      auth: { getUserIdentity: async () => ({ issuer: "https://jarvis-orcin-six.vercel.app", subject: "daniel-owner" }) },
      db: {
        normalizeId: (_table: string, id: string) => id,
        query: (table: string) => {
          const read = { table, equalities: {} } as (typeof reads)[number];
          reads.push(read);
          const indexQuery = { eq(field: string, value: unknown) { read.equalities[field] = value; return indexQuery; } };
          const builder = {
            withIndex(index: string, apply: (q: typeof indexQuery) => unknown) { read.index = index; apply(indexQuery); return builder; },
            order(order: string) { read.order = order; return builder; },
            async take(limit: number) {
              read.limit = limit;
              if (table === "jobRuntime" && read.index === "by_plan_parent_generation_node") return activities(2);
              return responses[table] ?? [];
            },
            async first() {
              read.first = true;
              if (table === "missionRuntime") return { missionId: "mission-1", goal: "Ship fleet", mode: "goal", status: "running", phase: "building", percent: 20, planDigest: "digest", planGeneration: 1 };
              return null;
            },
          };
          return builder;
        },
      },
    };
    const handler = (snapshot as unknown as { _handler: (context: unknown, args: { threadId?: string }) => Promise<any> })._handler;
    const result = await handler(ctx, { threadId });
    expect(result.fleet).toMatchObject({ id: "mission-1", planDigest: "digest", planGeneration: 1 });
    expect(reads).toEqual([
      { table: "jobRuntime", index: "by_thread_visibility_active_priority", equalities: { originThreadId: threadId, visibility: "conversation", active: true }, order: "desc", limit: ACTIVE_CANDIDATE_LIMIT },
      { table: "missionRuntime", index: "by_mission", equalities: { missionId: "mission-1" }, first: true },
      { table: "goalPlanNodes", index: "by_parent_generation", equalities: { parentMissionId: "mission-1", planGeneration: 1 }, limit: 9 },
      { table: "goalPlanEdges", index: "by_parent_generation", equalities: { parentMissionId: "mission-1", planGeneration: 1 }, limit: 29 },
      { table: "goalHandoffs", index: "by_parent_generation", equalities: { parentMissionId: "mission-1", planGeneration: 1 }, limit: 9 },
      { table: "jobRuntime", index: "by_plan_parent_generation_node", equalities: { planParentMissionId: "mission-1", planGeneration: 1 }, limit: 9 },
    ]);
    expect(reads.some((read) => ["jobs", "approvals", "attentionItems", "workEvents"].includes(read.table))).toBe(false);
  });
});
