import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildContext } from "./context";

const at = Date.now() - 60_000;

function source(name: string) {
  return { provenance: [`${name}.bounded_index`], sourceUpdatedAt: at, refreshedAt: at + 1_000 };
}

function compactSnapshot() {
  return {
    memory: [{ id: "memory-1", title: "Daniel preference", body: "Keep grounded answers useful.", updatedAt: at }],
    business: [{ domain: "rental", headline: "Rental occupancy is healthy", detail: "No urgent intervention.", updatedAt: at }],
    projects: [{ slug: "jarvis", status: "healthy", summary: "Foreground intelligence", data: { purpose: "Be Daniel's reliable assistant", objectives: ["Fast grounded turns"] }, updatedAt: at }],
    goals: [{ id: "goal-1", project: "jarvis", title: "Grounded foreground turns", outcome: "Useful low-latency context", status: "active", priority: 90, progress: 75, nextAction: "Validate production", updatedAt: at }],
    goalMissions: [{ id: "mission-1", goal: "Repair context I/O", status: "running", phase: "validation", percent: 80, revisionWave: 0, updatedAt: at }],
    jobs: [{ id: "job-1", agentId: "sentry", label: "Sentry · context repair", task: "Validate context repair", status: "running", stage: "testing", percent: 80, attempt: 1, updatedAt: at }],
    findings: [{ id: "finding-1", spoken: "The context read is bounded.", createdAt: at }],
    trip: { id: "trip-1", title: "Lisbon", status: "planning", budgetGbp: 1_500, projectedTotal: 1_200, lockedTotal: 300, activities: ["tram tour"], updatedAt: at },
    draft: { id: "draft-1", title: "Reliability note", data: "This is the active reliability draft.", updatedAt: at },
    location: { key: "location", type: "location", value: "51.5,-0.1", title: "London", updatedAt: at },
    panel: { key: "panel", type: "widget", title: "Reliability ranking", value: JSON.stringify({ kind: "ranking", title: "Reliability ranking", items: [{ rank: 1, name: "Context projection" }] }), updatedAt: at },
    creations: [{ id: "creation-1", kind: "board", title: "Context architecture", folder: "Projects / Jarvis", project: "jarvis", updatedAt: at }],
    agents: [{ slug: "sentry", name: "Sentry", role: "Reliability & Review Lead", status: "working", activeJobCount: 1, updatedAt: at }],
    attention: [{ id: "attention-1", title: "Validate production reads", detail: "Compare exact Convex document and byte metrics.", impact: 90, urgency: 80, confidence: 1, actionClass: "inform", status: "open", updatedAt: at }],
    approvals: [{ jobId: "approval-1", summary: "A consequential action", risk: "consequential", requestedAt: at }],
    sources: {
      memory: source("brainMemory"),
      business: source("businessState"),
      projects: source("projectState"),
      work: source("jobRuntime"),
      attention: source("attentionItems"),
      artifacts: source("creations"),
      ui: source("ui"),
    },
    generatedAt: at + 2_000,
    projection: {
      state: "fresh",
      version: 3,
      generatedAt: at + 2_000,
      payloadBytes: 12_345,
      memoryIndexComplete: true,
      refreshRecommended: false,
    },
  };
}

describe("buildContext compact projection integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves memory, project, attention, work, artifact and trip signals with provenance", async () => {
    const brain = compactSnapshot();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.path === "brainContext:snapshot") return { json: async () => ({ value: brain }) } as Response;
      if (body.path === "jarvisContext:snapshot") {
        return {
          json: async () => ({
            value: {
              todos: [{ text: "Review reliability evidence" }],
              events: [{ title: "Context review", start: at + 86_400_000 }],
              wealth: { currentTotalGBP: 123_456 },
            },
          }),
        } as Response;
      }
      throw new Error(`Unexpected Convex path ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const block = await buildContext("How is the Jarvis context repair going?");

    expect(block.length).toBeLessThanOrEqual(12_000);
    expect(block).toContain("CONTEXT READ MODEL: fresh projection v3");
    expect(block).toContain("Long-term memory (brainMemory.bounded_index; source updated");
    expect(block).toContain("PROJECT INTELLIGENCE");
    expect(block).toContain("RANKED ATTENTION");
    expect(block).toContain("Permanent team work right now");
    expect(block).toContain("RECENT CREATIONS");
    expect(block).toContain("Context architecture");
    expect(block).toContain("TRIP IN PROGRESS id=trip-1");
    expect(block).toContain("ACTIVE DRAFT \"Reliability note\"");
    expect(block).toContain("ON SCREEN NOW: a ranking overlay");
    expect(block).toContain("NEEDS DANIEL");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps stale last-known-good context visible while re-arming background recovery", async () => {
    const brain = compactSnapshot();
    brain.projection = { ...brain.projection, state: "stale", refreshRecommended: true };
    const paths: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      paths.push(body.path);
      if (body.path === "brainContext:snapshot") return { json: async () => ({ value: brain }) } as Response;
      if (body.path === "jarvisContext:snapshot") {
        return { json: async () => ({ value: { todos: [], events: [], wealth: null } }) } as Response;
      }
      if (body.path === "contextProjection:kick") return { json: async () => ({ value: true }) } as Response;
      throw new Error(`Unexpected Convex path ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const block = await buildContext("What still needs attention?");

    expect(paths).toContain("brainContext:snapshot");
    expect(paths).toContain("contextProjection:kick");
    expect(block).toContain("CONTEXT READ MODEL: stale projection v3");
    expect(block).toContain("Validate production reads");
    expect(block).toContain("This is last-known-good state");
  });

  it("labels migration coverage honestly instead of calling a partial active slice complete", async () => {
    const brain = compactSnapshot();
    brain.projection = { ...brain.projection, state: "migrating", activeIndexComplete: false } as any;
    const paths: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      paths.push(body.path);
      if (body.path === "brainContext:snapshot") return { json: async () => ({ value: brain }) } as Response;
      if (body.path === "jarvisContext:snapshot") {
        return { json: async () => ({ value: { todos: [], events: [], wealth: null } }) } as Response;
      }
      throw new Error(`Unexpected Convex path ${body.path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const block = await buildContext("What is active?");

    expect(block).toContain("active work and attention coverage may be incomplete");
    expect(block).not.toContain("complete rollout snapshot");
    expect(paths).toContain("brainContext:snapshot");
    expect(paths).not.toContain("contextProjection:bootstrap");
    expect(paths).not.toContain("contextProjection:kick");
  });
});
