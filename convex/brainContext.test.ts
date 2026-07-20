import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapshot } from "./brainContext";
import {
  BRAIN_CONTEXT_KEY,
  BRAIN_CONTEXT_VERSION,
  CONTEXT_SOURCES,
  MAX_MEMORY_MATCHES,
  MAX_PROJECTION_PAYLOAD_BYTES,
  emptyBrainContext,
  estimateJsonBytes,
  fitBrainContextPayload,
  materiallyDifferentWork,
  projectMemoryRow,
} from "./brainContextModel";

function semanticPayload() {
  const at = 1_720_000_000_000;
  const payload = emptyBrainContext(at);
  payload.memory = [{ id: "memory-recent", kind: "project", title: "Jarvis direction", body: "Keep answers grounded.", updatedAt: at }];
  payload.business = [{ domain: "rental", headline: "Occupancy is healthy", updatedAt: at }];
  payload.projects = [{ slug: "jarvis", status: "healthy", summary: "Foreground assistant", data: { purpose: "Help Daniel" }, updatedAt: at }];
  payload.goals = [{ id: "goal-1", project: "jarvis", title: "Fast grounded turns", outcome: "Reliable context", status: "active", priority: 90, progress: 60, updatedAt: at }];
  payload.goalMissions = [{ id: "mission-1", goal: "Repair context", status: "running", phase: "testing", percent: 70, updatedAt: at }];
  payload.jobs = [{ id: "job-1", agentId: "sentry", task: "Verify provider reads", status: "running", stage: "testing", percent: 70, priority: 90, updatedAt: at }];
  payload.findings = [{ id: "finding-1", spoken: "The compact projection is ready.", createdAt: at }];
  payload.trip = { id: "trip-1", title: "Lisbon", status: "planning", budgetGbp: 1_500, projectedTotal: 1_200, lockedTotal: 300, activities: ["tram tour"], updatedAt: at };
  payload.draft = { id: "draft-1", title: "Launch note", data: "A useful active draft.", updatedAt: at };
  payload.location = { key: "location", type: "location", value: "51.5,-0.1", title: "London", updatedAt: at };
  payload.panel = { key: "panel", type: "widget", title: "Priorities", value: JSON.stringify({ kind: "ranking", title: "Priorities", items: [{ rank: 1, name: "Reliability" }] }), updatedAt: at };
  payload.creations = [{ id: "artifact-1", kind: "board", title: "Reliability map", folder: "Projects / Jarvis", updatedAt: at }];
  payload.agents = [{ slug: "sentry", name: "Sentry", role: "Reliability Lead", status: "working", activeJobCount: 1, updatedAt: at }];
  payload.attention = [{ id: "attention-1", title: "Validate rollout", detail: "Compare Convex metrics", severity: "warning", impact: 80, urgency: 70, confidence: 1, actionClass: "inform", status: "open", updatedAt: at }];
  payload.approvals = [{ jobId: "job-2", summary: "Consequential production action", risk: "consequential", requestedAt: at }];
  for (const source of CONTEXT_SOURCES) {
    payload.sources[source] = { provenance: [`${source}.bounded_index`], sourceUpdatedAt: at, refreshedAt: at };
  }
  return fitBrainContextPayload(payload);
}

type Read = {
  table: string;
  index?: string;
  search?: string;
  limit?: number;
  documents: number;
  bytes: number;
};

function queryContext(options?: { projection?: any; refresh?: any; matches?: any[] }) {
  const reads: Read[] = [];
  const rows: Record<string, any> = {
    brainContextProjection: options?.projection ?? null,
    brainContextRefresh: options?.refresh ?? null,
    brainMemory: options?.matches ?? [],
  };
  const ctx = {
    auth: {
      getUserIdentity: async () => ({
        issuer: "https://jarvis-orcin-six.vercel.app",
        subject: "daniel-owner",
      }),
    },
    db: {
      query(table: string) {
        const read: Read = { table, documents: 0, bytes: 0 };
        reads.push(read);
        const builder = {
          withIndex(index: string, apply?: (q: any) => unknown) {
            read.index = index;
            apply?.({ eq: () => ({}) });
            return builder;
          },
          withSearchIndex(index: string, apply: (q: any) => unknown) {
            read.index = index;
            apply({
              search(field: string) {
                read.search = field;
                return {};
              },
            });
            return builder;
          },
          async first() {
            const row = rows[table];
            if (row) {
              read.documents = 1;
              read.bytes = estimateJsonBytes(row);
            }
            return row;
          },
          async take(limit: number) {
            read.limit = limit;
            const selected = (Array.isArray(rows[table]) ? rows[table] : []).slice(0, limit);
            read.documents = selected.length;
            read.bytes = selected.reduce((sum, row) => sum + estimateJsonBytes(row), 0);
            return selected;
          },
        };
        return builder;
      },
    },
  };
  return { ctx, reads };
}

describe("brainContext compact foreground contract", () => {
  it("reads two singleton rows and at most four bounded memory DTOs", async () => {
    const payload = semanticPayload();
    const projection = {
      _id: "projection-1",
      key: BRAIN_CONTEXT_KEY,
      version: BRAIN_CONTEXT_VERSION,
      payload,
      payloadBytes: estimateJsonBytes(payload),
      generatedAt: payload.generatedAt,
    };
    const refresh = {
      _id: "refresh-1",
      key: BRAIN_CONTEXT_KEY,
      version: BRAIN_CONTEXT_VERSION,
      generation: 4,
      dirtySources: [],
      requestedAt: payload.generatedAt,
      lastCompletedAt: payload.generatedAt,
      memoryComplete: true,
      memoryVersion: 1,
      updatedAt: payload.generatedAt,
    };
    const matches = Array.from({ length: MAX_MEMORY_MATCHES }, (_, index) => projectMemoryRow({
      _id: `memory-${index}`,
      kind: "knowledge",
      title: `Relevant memory ${index} ${"t".repeat(200)}`,
      body: `Bounded relevant detail ${index} ${"b".repeat(2_000)}`,
      tags: Array.from({ length: 20 }, () => "reliability-tag"),
      createdAt: payload.generatedAt - index,
      updatedAt: payload.generatedAt - index,
    }));
    const { ctx, reads } = queryContext({ projection, refresh, matches });
    const handler = (snapshot as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<any> })._handler;
    const result = await handler(ctx, { userText: "What is the latest reliability context?" });

    expect(reads.map((read) => ({ table: read.table, index: read.index, limit: read.limit }))).toEqual([
      { table: "brainContextProjection", index: "by_key", limit: undefined },
      { table: "brainContextRefresh", index: "by_key", limit: undefined },
      { table: "brainMemory", index: "search_text", limit: MAX_MEMORY_MATCHES },
    ]);
    expect(reads.reduce((sum, read) => sum + read.documents, 0)).toBe(2 + MAX_MEMORY_MATCHES);
    expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(42_000);
    expect(result.memory[0]).toMatchObject({ id: "memory-0", title: expect.stringContaining("Relevant memory") });
    expect(result.projects[0].slug).toBe("jarvis");
    expect(result.attention[0].title).toBe("Validate rollout");
    expect(result.trip.id).toBe("trip-1");
    expect(result.projection).toMatchObject({ state: "fresh", payloadBytes: projection.payloadBytes });
  });

  it("uses an explicit empty DTO on a cold projection without scanning source tables", async () => {
    const { ctx, reads } = queryContext();
    const handler = (snapshot as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<any> })._handler;
    const result = await handler(ctx, {});

    expect(reads.map((read) => read.table)).toEqual(["brainContextProjection", "brainContextRefresh"]);
    expect(result).toMatchObject({
      memory: [],
      projects: [],
      jobs: [],
      attention: [],
      creations: [],
      trip: null,
      projection: { state: "missing", refreshRecommended: true },
    });
  });

  it("contains no operational-table fan-out or duplicate status scans", () => {
    const source = readFileSync(new URL("./brainContext.ts", import.meta.url), "utf8");
    for (const table of [
      "memory\"",
      "businessState",
      "projectState",
      "jobRuntime",
      "findings\"",
      "creations\"",
      "agentProfiles",
      "attentionItems",
      "approvals\"",
      "projectGoals",
      "missionRuntime",
    ]) expect(source).not.toContain(`query(\"${table}`);
    expect(source).not.toContain("activeStatuses");
    expect(source).not.toContain(".collect()");
  });
});

describe("brain context projection bounds", () => {
  it("fits worst-case bounded source slices while retaining every useful signal class", () => {
    const payload = semanticPayload();
    const huge = "x".repeat(5_000);
    payload.memory = Array.from({ length: 10 }, (_, index) => ({ id: `m-${index}`, title: huge, body: huge }));
    payload.projects = Array.from({ length: 24 }, (_, index) => ({ slug: `project-${index}`, status: "healthy", summary: huge, data: { purpose: huge, vision: huge, objectives: [huge], recent: huge } }));
    payload.goals = Array.from({ length: 16 }, (_, index) => ({ id: `g-${index}`, project: "jarvis", title: huge, outcome: huge, status: "active" }));
    payload.jobs = Array.from({ length: 10 }, (_, index) => ({ id: `j-${index}`, task: huge, status: "running", stage: huge }));
    payload.attention = Array.from({ length: 8 }, (_, index) => ({ id: `a-${index}`, title: huge, detail: huge, status: "open" }));
    payload.creations = Array.from({ length: 10 }, (_, index) => ({ id: `c-${index}`, kind: "board", title: huge }));
    payload.findings = Array.from({ length: 6 }, (_, index) => ({ id: `f-${index}`, spoken: huge }));
    payload.goalMissions = Array.from({ length: 6 }, (_, index) => ({ id: `gm-${index}`, goal: huge, status: "running" }));
    payload.business = Array.from({ length: 8 }, (_, index) => ({ domain: `d-${index}`, headline: huge, detail: huge }));
    payload.draft = { id: "draft", title: huge, data: huge, updatedAt: payload.generatedAt };

    const fitted = fitBrainContextPayload(payload);
    expect(estimateJsonBytes(fitted)).toBeLessThanOrEqual(MAX_PROJECTION_PAYLOAD_BYTES);
    for (const key of ["memory", "projects", "goals", "jobs", "attention", "creations"] as const) {
      expect(fitted[key].length, key).toBeGreaterThan(0);
    }
    expect(fitted.trip).not.toBeNull();
    expect(fitted.sources.memory?.provenance[0]).toContain("memory");
  });

  it("does not refresh work for heartbeat-only churn", () => {
    const previous = { status: "running", stage: "testing", percent: 42, heartbeatAt: 100, updatedAt: 100 };
    expect(materiallyDifferentWork(previous, { ...previous, heartbeatAt: 200, updatedAt: 200 })).toBe(false);
    expect(materiallyDifferentWork(previous, { ...previous, percent: 49 })).toBe(false);
    expect(materiallyDifferentWork(previous, { ...previous, percent: 50 })).toBe(true);
    expect(materiallyDifferentWork(previous, { ...previous, stage: "provider validation" })).toBe(true);
    expect(materiallyDifferentWork(previous, { ...previous, status: "done" })).toBe(true);
  });
});
