import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompactWorkSnapshot, FleetNode } from "../lib/active-work";
import { FleetCommandCenter, FleetDag, fleetDagLayout, fleetNodeStateLabel } from "./CompactWorkBar";

const node = (overrides: Partial<FleetNode> = {}): FleetNode => ({
  id: "surface", jobId: "job-1", label: "Unified fleet surface", agent: "paul",
  repository: "daniels-project-space/jarvis", state: "running", status: "running", stage: "testing",
  percent: 64, progress: "Running focused tests", progressAt: 1, model: "terra", reasoningEffort: "high",
  modelReason: "Terra/high for bounded implementation and validation",
  workerRuntime: "trigger", workerRunId: "run-1", generation: 1, attempt: 1, maxAttempts: 12,
  dependencyCount: 0, dependenciesReady: 0, integrationState: "not_applicable", deliveryStatus: null,
  mergeState: "not started", recoverySummary: null, needsDaniel: false, attentionReason: null,
  controls: ["pause", "cancel", "steer"], startedAt: 1, ...overrides,
});

const work: CompactWorkSnapshot = {
  active: { id: "job-1", missionId: "mission-1", label: "Unified fleet surface", status: "running", stage: "testing", percent: 64, extraCount: 2, needsDaniel: false },
  fleet: {
    id: "mission-1", goal: "Build one live fleet surface", mode: "goal", status: "running", phase: "building",
    percent: 64, repository: "daniels-project-space/jarvis", planDigest: "abcdef0123456789", planGeneration: 2,
    integrationState: "building", attentionCount: 0, controls: ["pause", "cancel", "steer"],
    nodes: [node()], edges: [],
  },
  hierarchy: [{
    id: "mission-group-1", label: "Build one live fleet surface", status: "running", phase: "building",
    projects: [{
      id: "project-group-1", canonicalProjectId: "jarvis", repository: "daniels-project-space/jarvis",
      jobs: [node()],
    }],
  }],
};

describe("FleetCommandCenter", () => {
  it("renders nothing for an empty or hidden result", () => {
    expect(renderToStaticMarkup(<FleetCommandCenter snapshot={{ active: null, fleet: null, hierarchy: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<FleetCommandCenter snapshot={work} hidden />)).toBe("");
  });

  it("renders one immutable mission-project hierarchy with active jobs and routing reasons only once", () => {
    const second = node({
      id: "second", jobId: "job-2", label: "Concurrent same-repository mission", agent: "atlas",
      model: "sol", reasoningEffort: "max", modelReason: "Sol/max for integration authority review",
    });
    const completed = node({ id: "done", jobId: "job-done", label: "Legacy completed tile", state: "done", status: "done" });
    const snapshot: CompactWorkSnapshot = {
      ...work,
      fleet: { ...work.fleet!, nodes: [node(), second, completed] },
      hierarchy: [
        work.hierarchy[0],
        {
          id: "mission-group-2", label: "Second mission", status: "running", phase: "reviewing",
          projects: [{
            id: "project-group-2", canonicalProjectId: "jarvis", repository: "daniels-project-space/jarvis",
            jobs: [second],
          }],
        },
      ],
    };
    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} initialExpanded />);
    expect(markup.match(/data-mission-group=/g)).toHaveLength(2);
    expect(markup.match(/data-project-group=/g)).toHaveLength(2);
    expect(markup.match(/data-active-job=/g)).toHaveLength(2);
    expect(markup).toContain('data-mission-group="mission-group-1"');
    expect(markup).toContain('data-mission-group="mission-group-2"');
    expect(markup).toContain('data-project-group="project-group-1"');
    expect(markup).toContain('data-project-group="project-group-2"');
    expect(markup).toContain("terra/high");
    expect(markup).toContain("Terra/high for bounded implementation and validation");
    expect(markup).toContain("sol/max");
    expect(markup).toContain("Sol/max for integration authority review");
    expect(markup).not.toContain("Legacy completed tile");
    expect(markup).not.toContain("Live fleet dependency graph");
    expect(markup).not.toContain("Fleet workstreams");
  });

  it("starts as exactly one compact ownership surface with the extra-worker count", () => {
    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={work} />);
    expect(markup.match(/data-fleet-surface/g)).toHaveLength(1);
    expect(markup).toContain('data-fleet-surface="collapsed"');
    expect(markup).toContain('data-work-id="job-1"');
    expect(markup).toContain("Unified fleet surface");
    expect(markup).toContain("+2");
    expect(markup).not.toContain("data-fleet-worker-detail");
    expect(markup).not.toContain("live work terminal");
  });

  it("does not auto-open a resolved mission from before this browser session", () => {
    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={work} />);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-fleet-surface="expanded"');
  });

  it("provides server-rendered HTML labels for every DAG node and a readable dependency-list fallback", () => {
    const nodes = [node({ id: "a", jobId: "job-a", label: "Foundation" }), node({ id: "b", jobId: "job-b", label: "Validation", dependencyCount: 1 })];
    const edges = [{ id: "a->b", source: "a", target: "b", readiness: "ready" as const }];
    const markup = renderToStaticMarkup(<FleetDag nodes={nodes} edges={edges} />);
    expect(markup).toContain("Live fleet dependency graph");
    expect(markup.match(/data-fleet-node/g)).toHaveLength(nodes.length);
    expect(markup).toContain('aria-label="Paul: Foundation, 64% running"');
    expect(markup).toContain('aria-label="Paul: Validation, 64% running"');
    expect(markup).toContain('aria-label="Live fleet node states"');
    expect(markup).toContain('aria-label="Fleet dependency list"');
    expect(markup).toContain(">Validation</span> · after a (ready)");
    expect(markup).toContain('aria-label="Handoff readiness legend"');
    expect(fleetDagLayout(nodes, edges)).toHaveLength(2);
  });

  it("uses complete compact state labels while preserving each full state for assistive technology", () => {
    expect(Object.fromEntries((["queued", "dependency_held", "dispatching", "running", "reviewing", "integrating", "paused", "done", "blocked", "needs_input"] as FleetNode["state"][]).map((state) => [state, fleetNodeStateLabel(state)]))).toEqual({
      queued: "queue", dependency_held: "held", dispatching: "send", running: "run", reviewing: "review",
      integrating: "merge", paused: "pause", done: "done", blocked: "block", needs_input: "input",
    });
    const markup = renderToStaticMarkup(<FleetDag nodes={[node({ agent: "jarvis", state: "integrating", percent: 100 })]} edges={[]} />);
    expect(markup).toContain('aria-label="JARVIS: Unified fleet surface, 100% integrating"');
    expect(markup).toContain('title="integrating"');
    expect(markup).toContain("JARVIS");
    expect(markup).toContain("100% merge");
  });

  it("keeps dependency depths stable when input nodes arrive in another order", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" }), node({ id: "c" }), node({ id: "d" })];
    const edges = [
      { id: "a-c", source: "a", target: "c", readiness: "ready" as const },
      { id: "b-c", source: "b", target: "c", readiness: "ready" as const },
      { id: "c-d", source: "c", target: "d", readiness: "waiting" as const },
    ];
    expect(fleetDagLayout(nodes, edges)).toEqual(fleetDagLayout([...nodes].reverse(), [...edges].reverse()));
    expect(Object.fromEntries(fleetDagLayout(nodes, edges).map((position) => [position.id, position.depth]))).toEqual({ a: 0, b: 0, c: 1, d: 2 });
  });

  it("lays out a branch-and-merge DAG by its longest persisted dependency path", () => {
    const nodes = ["root", "research", "build", "review", "merge"].map((id) => node({ id }));
    const edges = [
      { id: "root-research", source: "root", target: "research", readiness: "delivered" as const },
      { id: "root-build", source: "root", target: "build", readiness: "delivered" as const },
      { id: "research-review", source: "research", target: "review", readiness: "ready" as const },
      { id: "build-review", source: "build", target: "review", readiness: "ready" as const },
      { id: "review-merge", source: "review", target: "merge", readiness: "waiting" as const },
    ];
    expect(Object.fromEntries(fleetDagLayout(nodes, edges).map((position) => [position.id, position.depth]))).toEqual({ build: 1, merge: 3, research: 1, review: 2, root: 0 });
  });

  it("bounds malformed and cyclic edges without manufacturing a node or looping", () => {
    const nodes = [node({ id: "a" }), node({ id: "b" })];
    const edges = [
      { id: "a-b", source: "a", target: "b", readiness: "ready" as const },
      { id: "b-a", source: "b", target: "a", readiness: "blocked" as const },
      { id: "missing-b", source: "missing", target: "b", readiness: "waiting" as const },
    ];
    const positions = fleetDagLayout(nodes, edges);
    expect(positions.map((position) => position.id)).toEqual(["a", "b"]);
    expect(positions.every((position) => position.depth >= 0 && position.depth <= 1)).toBe(true);
  });

  it("removes the superseded AgentLiveView and flat FleetView ownership paths", () => {
    const jarvis = readFileSync(new URL("./JarvisUI.tsx", import.meta.url), "utf8");
    const views = readFileSync(new URL("./Views.tsx", import.meta.url), "utf8");
    expect(jarvis).not.toContain("AgentLiveView");
    expect(jarvis).not.toContain("api.jobs.active");
    expect(views).not.toContain("export function FleetView");
    expect(views).not.toContain("api.missions.activity");
    expect(jarvis.match(/<FleetCommandCenter/g)).toHaveLength(1);
  });
});
