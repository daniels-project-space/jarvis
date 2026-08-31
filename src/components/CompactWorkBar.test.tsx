import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CompactWorkSnapshot, FleetNode } from "../lib/active-work";
import {
  SUPERVISOR_INPUT_TOO_LARGE_ERROR,
  supervisorInputUtf8Bytes,
  supervisorInputValidationError,
} from "../lib/supervisor-control";
import {
  FleetCommandCenter,
  FleetDag,
  WorkerDetail,
  compactWorkCardSelection,
  fetchWorkRealtimeTicket,
  fleetDagLayout,
  fleetNodeStateLabel,
  legacyWorkControlPayload,
  liveWorkElapsedLabel,
  liveWorkFreshnessLabel,
  liveWorkHeartbeatLabel,
  liveWorkHeartbeatState,
  liveWorkSignalNode,
  mergeRealtimeWorkNode,
  preserveSupervisorRequestKey,
  realtimeWorkSignalState,
  shouldRemintWorkRealtimeTicket,
  submitSupervisorControlRequest,
  supervisorControlPayload,
  supervisorRequestIdentity,
  workRealtimeRetryDelay,
  workModelLabel,
  workStatusLabel,
  workTaskTitle,
  workerDetailControls,
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
    expect(markup).toContain("Terra · high effort");
    expect(markup).toContain("Terra/high for bounded implementation and validation");
    expect(markup).toContain("Sol · max effort");
    expect(markup).toContain("Sol/max for integration authority review");
    expect(markup).toContain('data-work-progress-bar="fleet"');
    expect(markup).toContain('aria-label="Build one live fleet surface overall progress"');
    expect(markup).toContain('aria-valuenow="64"');
    expect(markup).toContain('data-expanded-work-progress="job-1"');
    expect(markup).toContain('data-expanded-work-progress="job-2"');
    expect(markup).not.toContain("Legacy completed tile");
    expect(markup).not.toContain("Live fleet dependency graph");
    expect(markup).not.toContain("Fleet workstreams");
  });

  it("starts as a compact card stack with one clear card per active task", () => {
    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={work} />);
    expect(markup.match(/data-fleet-surface/g)).toHaveLength(1);
    expect(markup).toContain('data-fleet-surface="collapsed"');
    expect(markup).toContain('data-work-id="job-1"');
    expect(markup).toContain('data-work-card="job-1"');
    expect(markup).toContain("Unified fleet surface");
    expect(markup).toContain('data-work-progress="64"');
    expect(markup).toContain('data-work-realtime="durable"');
    expect(markup).toContain("Running focused tests");
    expect(markup).toContain("checkpoint");
    expect(markup).toContain("waiting for heartbeat");
    expect(markup).toContain("data-work-live-timing");
    expect(markup).toContain("data-work-progress-ring");
    expect(markup).toContain("data-work-progress-meter");
    expect(markup).toContain("stroke-dashoffset=\"36\"");
    expect(markup).toContain('style="width:64%"');
    expect(markup).toContain("Terra · high effort");
    expect(markup).not.toContain("data-fleet-worker-detail");
    expect(markup).not.toContain("live work terminal");
  });

  it("merges only exact-job realtime progress and clamps untrusted metadata", () => {
    const durable = node({ percent: 35, stage: "building", progress: "Durable checkpoint", progressAt: 100 });
    const merged = mergeRealtimeWorkNode(durable, {
      jobId: "job-1",
      percent: 127,
      stage: "  validating production  ",
      progress: "  Inspecting the deployed widget  ",
    }, 500);
    expect(merged).toMatchObject({
      percent: 100,
      stage: "validating production",
      progress: "Inspecting the deployed widget",
      progressAt: 500,
    });
    expect(mergeRealtimeWorkNode(durable, {
      jobId: "stale-job",
      percent: 99,
      progress: "Wrong worker",
    }, 900)).toBe(durable);
    expect(mergeRealtimeWorkNode(durable, {
      jobId: "job-1",
      percent: Number.NaN,
      stage: "",
      progress: "",
    })).toMatchObject({ percent: 35, stage: "building", progress: "Durable checkpoint", progressAt: 100 });
  });

  it("never labels mismatched, failed, or completed realtime metadata as live", () => {
    const metadata = { jobId: "job-1", percent: 80 };
    expect(realtimeWorkSignalState("job-1", metadata)).toBe("realtime");
    expect(realtimeWorkSignalState("job-2", metadata)).toBe("connecting");
    expect(realtimeWorkSignalState("job-1", metadata, { hasError: true })).toBe("connecting");
    expect(realtimeWorkSignalState("job-1", metadata, { finished: true })).toBe("durable");
  });

  it("streams the attention task first while preserving a meaningful secondary task", () => {
    const attention = node({ jobId: "job-attention", label: "Approval gate", needsDaniel: true, state: "needs_input", progress: "Choose the production cap", progressAt: 20 });
    const freshest = node({ id: "parallel", jobId: "job-parallel", label: "Parallel validation", progress: "Running mobile checks", progressAt: 90 });
    const snapshot: CompactWorkSnapshot = {
      ...work,
      active: { ...work.active!, needsDaniel: true },
      fleet: { ...work.fleet!, attentionCount: 1, nodes: [attention, freshest] },
      hierarchy: [{ ...work.hierarchy[0], projects: [{ ...work.hierarchy[0].projects[0], jobs: [attention, freshest] }] }],
    };
    expect(liveWorkSignalNode(snapshot)?.jobId).toBe("job-attention");
    expect(liveWorkSignalNode({ ...snapshot, active: { ...snapshot.active!, needsDaniel: false } })?.jobId).toBe("job-parallel");

    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} />);
    expect(markup).toContain('data-work-progress="64"');
    expect(markup).toContain("Approval gate");
    expect(markup).toContain("Choose the production cap");
    expect(markup).toContain("Your input is needed");
    expect(markup).toContain("Running mobile checks");
    expect(markup.match(/data-work-card=/g)).toHaveLength(2);
  });

  it("caps collapsed work to the current task plus one meaningful secondary and keeps the remainder on demand", () => {
    const attention = node({
      id: "attention",
      jobId: "job-attention",
      label: "Approval gate",
      needsDaniel: true,
      state: "needs_input",
      progress: "Choose the production cap",
      progressAt: 40,
    });
    const executing = node({
      id: "executing",
      jobId: "job-executing",
      label: "Live validation",
      state: "running",
      progress: "Checking the visual surface",
      progressAt: 30,
    });
    const queued = node({
      id: "queued",
      jobId: "job-queued",
      label: "Queued background task",
      state: "queued",
      progress: "Waiting for a worker",
      progressAt: 20,
    });
    const held = node({
      id: "held",
      jobId: "job-held",
      label: "Held follow-up",
      state: "dependency_held",
      progress: "Waiting for earlier work",
      progressAt: 10,
    });
    const nodes = [attention, executing, queued, held];
    const snapshot: CompactWorkSnapshot = {
      ...work,
      active: { ...work.active!, id: attention.jobId, needsDaniel: true },
      fleet: { ...work.fleet!, attentionCount: 1, nodes },
      hierarchy: [{ ...work.hierarchy[0], projects: [{ ...work.hierarchy[0].projects[0], jobs: nodes }] }],
    };

    const selection = compactWorkCardSelection(snapshot);
    expect(selection.visibleCards.map((entry) => entry.jobId)).toEqual(["job-attention", "job-executing"]);
    expect(selection.hiddenCount).toBe(2);

    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} />);
    expect(markup.match(/data-work-card=/g)).toHaveLength(2);
    expect(markup).toContain('data-work-more="true"');
    expect(markup).toContain("+2 more work");
    expect(markup).toContain("Open all 4 active Jarvis tasks; 2 more available");
    expect(markup).not.toContain("Queued background task");
    expect(markup).not.toContain("Held follow-up");
  });

  it("keeps the collapsed view to one current task when remaining work is not actionable or executing", () => {
    const current = node({ id: "current", jobId: "job-current", label: "Current task", progressAt: 20 });
    const queued = node({ id: "queued", jobId: "job-queued", label: "Queued background task", state: "queued", progressAt: 10 });
    const snapshot: CompactWorkSnapshot = {
      ...work,
      active: { ...work.active!, id: current.jobId },
      fleet: { ...work.fleet!, nodes: [current, queued] },
      hierarchy: [{ ...work.hierarchy[0], projects: [{ ...work.hierarchy[0].projects[0], jobs: [current, queued] }] }],
    };

    const selection = compactWorkCardSelection(snapshot);
    expect(selection.visibleCards.map((entry) => entry.jobId)).toEqual(["job-current"]);
    expect(selection.hiddenCount).toBe(1);
  });

  it("uses plain-English task, model, and recoverable system labels", () => {
    expect(workTaskTitle("Paul · In daniels-project-space/jarvis: fix random code labels"))
      .toBe("fix random code labels");
    expect(workModelLabel("terra", "high")).toBe("Terra · high effort");
    expect(workStatusLabel(node({
      state: "blocked",
      needsDaniel: false,
      attentionKind: "system",
      attentionLabel: "Secure worker setup",
    }))).toBe("Secure worker setup");

    const systemNode = node({
      jobId: "job-system",
      label: "Paul · In daniels-project-space/jarvis: continue provider work",
      state: "blocked",
      status: "paused",
      stage: "needs Daniel",
      attentionKind: "system",
      attentionLabel: "Secure worker setup",
      attentionReason: "No complete managed worker configuration is available",
      needsDaniel: false,
    });
    const snapshot: CompactWorkSnapshot = {
      ...work,
      active: { ...work.active!, id: systemNode.jobId, needsDaniel: false },
      fleet: { ...work.fleet!, phase: "needs Daniel", nodes: [systemNode] },
      hierarchy: [{ ...work.hierarchy[0], phase: "needs Daniel", projects: [{ ...work.hierarchy[0].projects[0], jobs: [systemNode] }] }],
    };
    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} />);
    expect(markup).toContain("continue provider work");
    expect(markup).toContain("Secure worker setup");
    expect(markup).not.toContain("Needs Daniel");
    const expanded = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} initialExpanded />);
    expect(expanded).toContain("Secure worker recovery");
    expect(expanded).not.toContain("needs Daniel");
  });

  it("keeps deliberately paused history out of the realtime card stack", () => {
    const paused = node({
      jobId: "job-paused-history",
      label: "Old paused maintenance",
      state: "paused",
      status: "paused",
      progress: "paused by Daniel",
    });
    const recovering = node({
      jobId: "job-paused-recovery",
      label: "Recover secure worker",
      state: "paused",
      status: "paused",
      attentionKind: "system",
      attentionLabel: "Secure worker setup",
    });
    const snapshot: CompactWorkSnapshot = {
      ...work,
      active: { ...work.active!, id: paused.jobId },
      fleet: { ...work.fleet!, nodes: [paused, recovering] },
      hierarchy: [{ ...work.hierarchy[0], projects: [{ ...work.hierarchy[0].projects[0], jobs: [paused, recovering] }] }],
    };
    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} />);
    expect(markup).not.toContain("Old paused maintenance");
    expect(markup).toContain("Recover secure worker");
    expect(markup.match(/data-work-card=/g)).toHaveLength(1);
    expect(liveWorkSignalNode(snapshot)?.jobId).toBe(recovering.jobId);
  });

  it("keeps actively executing streamable work ahead of newer dormant work", () => {
    const running = node({ jobId: "job-running", label: "Active implementation", progressAt: 20 });
    const queued = node({
      id: "queued",
      jobId: "job-queued",
      label: "Future dependency",
      state: "dependency_held",
      status: "dependency_held",
      progressAt: 100,
      workerRunId: null,
    });
    const snapshot: CompactWorkSnapshot = {
      ...work,
      active: { ...work.active!, id: queued.jobId },
      fleet: { ...work.fleet!, nodes: [queued, running] },
      hierarchy: [{ ...work.hierarchy[0], projects: [{ ...work.hierarchy[0].projects[0], jobs: [queued, running] }] }],
    };
    expect(liveWorkSignalNode(snapshot)?.jobId).toBe("job-running");
  });

  it("renders one coherent bubble through real work lifecycle updates", () => {
    const lifecycle: Array<{ state: FleetNode["state"]; stage: string; percent: number; progress: string; needsDaniel?: boolean }> = [
      { state: "dispatching", stage: "dispatching", percent: 8, progress: "Assigning the specialist" },
      { state: "running", stage: "implementing", percent: 47, progress: "Building the progress surface" },
      { state: "reviewing", stage: "validating", percent: 82, progress: "Running behavioral tests" },
      { state: "needs_input", stage: "awaiting decision", percent: 82, progress: "Choose the production cap", needsDaniel: true },
    ];
    for (const phase of lifecycle) {
      const currentNode = node({
        state: phase.state,
        stage: phase.stage,
        percent: phase.percent,
        progress: phase.progress,
        progressAt: phase.percent,
        needsDaniel: phase.needsDaniel ?? false,
      });
      const snapshot: CompactWorkSnapshot = {
        active: { ...work.active!, status: phase.state, stage: phase.stage, percent: phase.percent, needsDaniel: phase.needsDaniel ?? false },
        fleet: { ...work.fleet!, phase: phase.stage, percent: phase.percent, attentionCount: phase.needsDaniel ? 1 : 0, nodes: [currentNode] },
        hierarchy: [{ ...work.hierarchy[0], phase: phase.stage, projects: [{ ...work.hierarchy[0].projects[0], jobs: [currentNode] }] }],
      };
      const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={snapshot} />);
      expect(markup).toContain(`data-work-progress="${phase.percent}"`);
      expect(markup).toContain(workStatusLabel(currentNode));
      expect(markup).toContain(phase.progress);
      expect(markup).toContain(`stroke-dashoffset="${100 - phase.percent}"`);
      expect(markup).toContain(`style="width:${phase.percent}%"`);
    }
  });

  it("describes signal freshness without inventing backend progress", () => {
    expect(liveWorkFreshnessLabel(null, 1_000)).toBe("waiting for signal");
    expect(liveWorkFreshnessLabel(1_000, null)).toBe("live signal");
    expect(liveWorkFreshnessLabel(1_000, 15_000)).toBe("live now");
    expect(liveWorkFreshnessLabel(1_000, 42_000)).toBe("updated 41s ago");
    expect(liveWorkFreshnessLabel(1_000, 181_000)).toBe("updated 3m ago");
    expect(liveWorkFreshnessLabel(1_000, 7_201_000)).toBe("updated 2h ago");
  });

  it("shows elapsed activity and heartbeat health without inventing percent progress", () => {
    expect(liveWorkElapsedLabel(1_000, 46_000)).toBe("active 45s");
    expect(liveWorkElapsedLabel(1_000, 421_000)).toBe("active 7m");
    expect(liveWorkElapsedLabel(1_000, 7_261_000)).toBe("active 2h 1m");
    expect(liveWorkElapsedLabel(1_000, 7_261_000, false)).toBe("finished");

    expect(liveWorkHeartbeatState(10_000, 40_000)).toBe("fresh");
    expect(liveWorkHeartbeatState(10_000, 80_000)).toBe("quiet");
    expect(liveWorkHeartbeatState(10_000, 101_000)).toBe("stale");
    expect(liveWorkHeartbeatLabel(10_000, 40_000)).toBe("heartbeat live");
    expect(liveWorkHeartbeatLabel(10_000, 101_000)).toBe("heartbeat delayed");

    const markup = renderToStaticMarkup(<FleetCommandCenter snapshot={work} initialExpanded />);
    expect(markup).toContain("64% checkpoint");
    expect(markup).toContain('data-work-heartbeat="waiting"');
    expect(markup).toContain("waiting for heartbeat");
    expect(markup).toContain('style="width:64%"');
    expect(markup).not.toContain("65% checkpoint");
  });

  it("requests one exact realtime run and uses the authoritative run id", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ runId: "run-authoritative", accessToken: "token-exact" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(fetchWorkRealtimeTicket("job-1", controller.signal, fetcher)).resolves.toEqual({
      kind: "connected",
      runId: "run-authoritative",
      accessToken: "token-exact",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/work-realtime", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ jobId: "job-1" }),
      signal: controller.signal,
    }));
  });

  it("separates forbidden realtime access from recoverable route and network failures", async () => {
    const signal = new AbortController().signal;
    const response = (status: number) => async () => new Response("{}", {
      status,
      headers: { "content-type": "application/json" },
    });
    const offline = async (): Promise<Response> => {
      throw new TypeError("offline");
    };

    await expect(fetchWorkRealtimeTicket("job-1", signal, response(403))).resolves.toEqual({ kind: "forbidden" });
    await expect(fetchWorkRealtimeTicket("job-1", signal, response(404))).resolves.toEqual({ kind: "retryable" });
    await expect(fetchWorkRealtimeTicket("job-1", signal, offline)).resolves.toEqual({ kind: "retryable" });
  });

  it("backs off quickly before settling into low-cost recovery", () => {
    expect([0, 1, 2, 3, 20].map(workRealtimeRetryDelay)).toEqual([
      2_000,
      6_000,
      15_000,
      60_000,
      60_000,
    ]);
    expect([0, 1, 2].map(shouldRemintWorkRealtimeTicket)).toEqual([false, false, false]);
    expect(shouldRemintWorkRealtimeTicket(3)).toBe(true);
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
    expect(expanded).toContain("0 active tasks · 1 planning");
    expect(expanded).not.toContain("data-active-job");
    expect(expanded).not.toContain("loading exact work detail");
  });

  it("does not invent supervised mission controls", () => {
    const snapshot: CompactWorkSnapshot = {
      ...work,
      fleet: {
        ...work.fleet!,
        mode: "supervised",
        controls: [],
        supervisor: {
          protocolVersion: 1,
          state: "ready",
          inputRevision: 4,
          steerRevision: 2,
          deadlineAt: 1_800_000_000_000,
        },
      },
    };

    const markup = renderToStaticMarkup(
      <FleetCommandCenter snapshot={snapshot} initialExpanded />,
    );

    expect(markup).toContain('data-supervisor-authority="ready:4"');
    expect(markup).not.toMatch(/>pause<\/button>/);
    expect(markup).not.toContain(">Stop worker</button>");
    expect(markup).not.toMatch(/>steer<\/button>/);
  });

  it("never duplicates supervised mission lifecycle controls in worker detail", () => {
    const supervisor = {
      protocolVersion: 1 as const,
      state: "needs_input" as const,
      inputRevision: 5,
      steerRevision: 2,
      deadlineAt: 1_800_000_000_000,
      question: "Use the protected delivery?",
    };
    const projectedControls: FleetNode["controls"] = [
      "pause",
      "resume",
      "cancel",
      "steer",
      "retry" as FleetNode["controls"][number],
      "provide_input",
      "approve",
      "decline",
    ];
    const mission = {
      id: "mission-1",
      mode: "supervised",
      supervisor,
    };
    const controls = workerDetailControls(projectedControls, {
      workerMissionId: "mission-1",
      mission,
    });
    const markup = renderToStaticMarkup(
      <WorkerDetail
        node={node({ controls: projectedControls })}
        workerMissionId="mission-1"
        mission={mission}
        onBack={() => undefined}
      />,
    );

    expect(controls).toEqual(["cancel", "provide_input", "approve", "decline"]);
    expect(markup).toContain("data-fleet-worker-detail");
    expect(markup).toContain('data-work-progress-bar="job-1"');
    expect(markup).toContain('aria-label="Unified fleet surface progress"');
    expect(markup).toContain('aria-valuenow="64"');
    expect(markup).toContain('data-work-control="cancel"');
    expect(markup).toContain("data-worker-activity");
    expect(markup.indexOf('data-work-control="cancel"')).toBeLessThan(markup.indexOf("data-worker-activity"));
    expect(markup).toContain(">Approve</button>");
    expect(markup).toContain(">Decline</button>");
    expect(markup).toContain(">Stop worker</button>");
    expect(markup).not.toMatch(/>(?:pause|resume|steer|retry)(?: exact control)?<\/button>/);
    expect(markup).not.toContain('aria-label="Answer Jarvis"');
  });

  it("renders legacy worker input and maps it to the bounded answer mutation", () => {
    const inputNode = node({
      state: "needs_input",
      status: "needs_input",
      controls: ["provide_input", "cancel"],
      attentionReason: "Choose whether to prepare a draft.",
      needsDaniel: true,
    });
    const markup = renderToStaticMarkup(
      <WorkerDetail
        node={inputNode}
        workerMissionId="work:job-1"
        mission={{ id: "work:job-1", mode: "work" }}
        onBack={() => undefined}
      />,
    );
    expect(markup).toContain('data-worker-answer="true"');
    expect(markup).toContain("Choose whether to prepare a draft.");
    expect(markup).toContain('aria-label="Answer Jarvis"');
    expect(legacyWorkControlPayload(
      { jobId: "job-1" },
      "provide_input",
      "Prepare a draft.",
    )).toEqual({ jobId: "job-1", action: "answer", input: "Prepare a draft." });
  });

  it("keeps supervised lifecycle controls on the mission authority surface", () => {
    const snapshot: CompactWorkSnapshot = {
      ...work,
      fleet: {
        ...work.fleet!,
        mode: "supervised",
        controls: ["pause", "cancel", "steer"],
        supervisor: {
          protocolVersion: 1,
          state: "ready",
          inputRevision: 4,
          steerRevision: 2,
          deadlineAt: 1_800_000_000_000,
        },
      },
    };
    const markup = renderToStaticMarkup(
      <FleetCommandCenter snapshot={snapshot} initialExpanded />,
    );

    expect(markup).toContain('data-supervisor-authority="ready:4"');
    expect(markup).toContain(">Pause work</button>");
    expect(markup).toContain(">Stop worker</button>");
    expect(markup).toContain(">Adjust task</button>");
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

  it("uses the UTF-8 byte boundary and refuses overflow before creating a key or calling the network", async () => {
    expect(supervisorInputUtf8Bytes("a".repeat(2_000))).toBe(2_000);
    expect(supervisorInputUtf8Bytes("é".repeat(1_000))).toBe(2_000);
    expect(supervisorInputValidationError("é".repeat(1_000))).toBeNull();
    expect(supervisorInputValidationError("é".repeat(1_001)))
      .toBe(SUPERVISOR_INPUT_TOO_LARGE_ERROR);

    const ambiguous = supervisorRequestIdentity(
      null,
      {
        missionId: "mission-supervised-1",
        action: "steer",
        expectedInputRevision: 7,
        input: "Keep the exact retry.",
      },
      () => "11111111-1111-4111-8111-111111111111",
    );
    const createUuid = vi.fn(
      () => "22222222-2222-4222-8222-222222222222",
    );
    const fetcher = vi.fn();
    const result = await submitSupervisorControlRequest({
      current: ambiguous,
      request: {
        missionId: "mission-supervised-1",
        action: "steer",
        expectedInputRevision: 8,
        input: "é".repeat(1_001),
      },
      replayAmbiguous: true,
      createUuid,
      fetcher,
    });
    expect(result).toEqual({
      ok: false,
      error: SUPERVISOR_INPUT_TOO_LARGE_ERROR,
      pendingRequest: null,
      responseStatus: 400,
      submitted: false,
    });
    expect(createUuid).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains one exact supervisor key only for ambiguous transport outcomes", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { ok: false, retryable: true, error: "Retry the same request." },
        { status: 503 },
      ))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const request = {
      missionId: "mission-supervised-1",
      action: "steer" as const,
      expectedInputRevision: 7,
      input: "Preserve the exact boundary.",
    };
    const first = await submitSupervisorControlRequest({
      current: null,
      request,
      createUuid: () => "11111111-1111-4111-8111-111111111111",
      fetcher,
    });
    expect(first.pendingRequest?.requestKey)
      .toBe("ui:11111111-1111-4111-8111-111111111111");
    expect(first.responseStatus).toBe(503);
    expect(first.submitted).toBe(true);

    const retry = await submitSupervisorControlRequest({
      current: first.pendingRequest,
      request,
      exactRetry: first.pendingRequest ?? undefined,
      fetcher,
    });
    expect(retry).toMatchObject({
      ok: true,
      pendingRequest: null,
      responseStatus: 200,
      submitted: true,
    });
    const sent = vi.mocked(fetcher).mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body))
    );
    expect(sent[0].requestKey).toBe(sent[1].requestKey);
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
    expect(workBar).toMatch(/data-fleet-surface="collapsed"[\s\S]{0,520}absolute left-2 top-2/);
    expect(workBar).toMatch(/data-fleet-surface="expanded"[\s\S]{0,260}md:left-2 md:right-auto/);
    expect(jarvis).toMatch(/<FleetCommandCenter[\s\S]{0,220}hidden=\{overlayUp \|\| workMapOpen\}/);
    expect(jarvis.match(/setPanel\(\{ type: "fleet"/g)).toHaveLength(1);
    expect(jarvis).toMatch(/onOpenGoals[\s\S]{0,300}setPanel\(\{ type: "fleet"/);
  });
});
