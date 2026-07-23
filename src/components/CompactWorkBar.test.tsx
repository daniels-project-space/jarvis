import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompactWorkSnapshot, FleetNode } from "../lib/active-work";
import {
  FleetCommandCenter,
  FleetDag,
  fleetDagLayout,
  fleetNodeStateLabel,
  preserveSupervisorRequestKey,
  supervisorControlPayload,
  supervisorRequestIdentity,
} from "./CompactWorkBar";

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

  it("renders supervised planning in the same one surface without a fake selectable job", () => {
    const planning = node({
      id: "supervisor:mission-planning",
      jobId: "supervisor:mission-planning",
      label: "Planning · Upgrade Jarvis",
      agent: "jarvis",
      state: "queued",
      status: "pending",
      stage: "ready to plan",
      percent: 0,
      progress: "",
      progressAt: null,
      model: null,
      reasoningEffort: null,
      modelReason: "Durable supervisor state is ready",
      workerRuntime: null,
      workerRunId: null,
      controls: [],
      projectionKind: "supervisor_planning",
    });
    const planningSnapshot: CompactWorkSnapshot = {
      active: {
        id: planning.jobId,
        missionId: "mission-planning",
        label: planning.label,
        status: "queued",
        stage: planning.stage,
        percent: 0,
        extraCount: 0,
        needsDaniel: false,
      },
      fleet: {
        ...work.fleet!,
        id: "mission-planning",
        goal: "Upgrade Jarvis",
        mode: "supervised",
        phase: "planning",
        percent: 0,
        controls: [],
        nodes: [planning],
        edges: [],
      },
      hierarchy: [{
        id: "mission-planning",
        label: "Upgrade Jarvis",
        status: "running",
        phase: "planning",
        projects: [{
          id: "mission-planning:planning",
          canonicalProjectId: "planning",
          repository: null,
          jobs: [planning],
        }],
      }],
    };

    const collapsed = renderToStaticMarkup(<FleetCommandCenter snapshot={planningSnapshot} />);
    const expanded = renderToStaticMarkup(<FleetCommandCenter snapshot={planningSnapshot} initialExpanded />);
    expect(collapsed.match(/data-fleet-surface/g)).toHaveLength(1);
    expect(collapsed).toContain('data-fleet-surface="collapsed"');
    expect(collapsed).toContain("Planning · Upgrade Jarvis");
    expect(expanded.match(/data-fleet-surface/g)).toHaveLength(1);
    expect(expanded.match(/data-supervisor-planning/g)).toHaveLength(1);
    expect(expanded).toContain("0 active jobs · 1 planning");
    expect(expanded).not.toContain("data-active-job");
    expect(expanded).not.toContain("loading exact work detail");
  });

  it("renders the supervisor question and answer separately from steering without adding another surface", () => {
    const planning = node({
      id: "supervisor:mission-input",
      jobId: "supervisor:mission-input",
      label: "Planning · Choose the delivery boundary",
      agent: "jarvis",
      state: "needs_input",
      status: "needs_input",
      stage: "waiting for Daniel",
      percent: 0,
      progress: "",
      progressAt: null,
      workerRuntime: null,
      workerRunId: null,
      controls: [],
      projectionKind: "supervisor_planning",
      needsDaniel: true,
    });
    const snapshot: CompactWorkSnapshot = {
      active: {
        id: planning.jobId,
        missionId: "mission-input",
        label: planning.label,
        status: "needs_input",
        stage: planning.stage,
        percent: 0,
        extraCount: 0,
        needsDaniel: true,
      },
      fleet: {
        ...work.fleet!,
        id: "mission-input",
        goal: "Choose the delivery boundary",
        mode: "supervised",
        phase: "needs input",
        percent: 0,
        controls: ["provide_input", "cancel"],
        supervisor: {
          protocolVersion: 1,
          state: "needs_input",
          inputRevision: 7,
          steerRevision: 2,
          deadlineAt: 1_800_000_000_000,
          question: "Should Jarvis prepare a draft or a production delivery?",
        },
        nodes: [planning],
        edges: [],
      },
      hierarchy: [{
        id: "mission-input",
        label: "Choose the delivery boundary",
        status: "needs_input",
        phase: "needs input",
        projects: [{
          id: "mission-input:planning",
          canonicalProjectId: "planning",
          repository: null,
          jobs: [planning],
        }],
      }],
    };

    const markup = renderToStaticMarkup(
      <FleetCommandCenter snapshot={snapshot} initialExpanded />,
    );
    expect(markup.match(/data-fleet-surface/g)).toHaveLength(1);
    expect(markup.match(/data-supervisor-planning/g)).toHaveLength(1);
    expect(markup).toContain('data-supervisor-authority="needs_input:7"');
    expect(markup).toContain("Should Jarvis prepare a draft or a production delivery?");
    expect(markup).toContain('data-supervisor-answer="true"');
    expect(markup).toContain('aria-label="Answer Jarvis"');
    expect(markup).toContain("send answer");
    expect(markup).not.toContain('aria-label="Steering instruction"');
    expect(markup).toMatch(/data-fleet-controls="true" class="[^"]*shrink-0/);
    expect(markup).not.toContain("data-active-job");
  });

  it("builds exact supervisor payloads and preserves one key only across ambiguous retries", () => {
    const request = {
      missionId: "mission-supervised-1",
      action: "provide_input" as const,
      expectedInputRevision: 7,
      input: "Use a production delivery.",
    };
    const first = supervisorRequestIdentity(
      null,
      request,
      () => "11111111-1111-4111-8111-111111111111",
    );
    const retry = supervisorRequestIdentity(
      first,
      request,
      () => "22222222-2222-4222-8222-222222222222",
    );
    const advancedDuringAmbiguousDispatch = supervisorRequestIdentity(
      retry,
      { ...request, expectedInputRevision: 8 },
      () => "22222222-2222-4222-8222-222222222222",
      true,
    );
    const changed = supervisorRequestIdentity(
      advancedDuringAmbiguousDispatch,
      {
        ...request,
        expectedInputRevision: 8,
        input: "Prepare a draft only.",
      },
      () => "33333333-3333-4333-8333-333333333333",
      true,
    );
    const changedAction = supervisorRequestIdentity(
      advancedDuringAmbiguousDispatch,
      {
        missionId: request.missionId,
        action: "cancel",
        expectedInputRevision: 8,
      },
      () => "44444444-4444-4444-8444-444444444444",
      true,
    );
    const changedMission = supervisorRequestIdentity(
      advancedDuringAmbiguousDispatch,
      { ...request, missionId: "mission-supervised-2" },
      () => "55555555-5555-4555-8555-555555555555",
      true,
    );
    expect(first.requestKey)
      .toBe("ui:11111111-1111-4111-8111-111111111111");
    expect(retry).toBe(first);
    expect(advancedDuringAmbiguousDispatch).toBe(first);
    expect(advancedDuringAmbiguousDispatch.request.expectedInputRevision)
      .toBe(7);
    expect(changed.requestKey)
      .toBe("ui:33333333-3333-4333-8333-333333333333");
    expect(changedAction.requestKey)
      .toBe("ui:44444444-4444-4444-8444-444444444444");
    expect(changedMission.requestKey)
      .toBe("ui:55555555-5555-4555-8555-555555555555");
    expect(supervisorControlPayload(
      advancedDuringAmbiguousDispatch.request,
      first.requestKey,
    )).toEqual({
      protocol: "supervisor_v1",
      missionId: "mission-supervised-1",
      action: "provide_input",
      requestKey: first.requestKey,
      expectedInputRevision: 7,
      input: "Use a production delivery.",
    });
    expect(preserveSupervisorRequestKey(null)).toBe(true);
    expect(preserveSupervisorRequestKey(503)).toBe(true);
    expect(preserveSupervisorRequestKey(200)).toBe(false);
    expect(preserveSupervisorRequestKey(409)).toBe(false);
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

  it("keeps the one work surface in the compact top-left or expanded side slot and yields to explicit panels", () => {
    const workBar = readFileSync(new URL("./CompactWorkBar.tsx", import.meta.url), "utf8");
    const jarvis = readFileSync(new URL("./JarvisUI.tsx", import.meta.url), "utf8");
    expect(workBar).toMatch(/data-fleet-surface="collapsed"[\s\S]{0,180}absolute left-2 top-2/);
    expect(workBar).toMatch(/data-fleet-surface="expanded"[\s\S]{0,260}md:left-2 md:right-auto/);
    expect(jarvis).toMatch(/<FleetCommandCenter[\s\S]{0,220}hidden=\{overlayUp\}/);
    expect(jarvis.match(/setPanel\(\{ type: "fleet"/g)).toHaveLength(1);
    expect(jarvis).toMatch(/onOpenGoals[\s\S]{0,300}setPanel\(\{ type: "fleet"/);
  });
});
