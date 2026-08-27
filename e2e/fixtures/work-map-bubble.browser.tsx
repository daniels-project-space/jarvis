import { createRoot } from "react-dom/client";
import type { CompactWorkSnapshot, FleetNode } from "../../src/lib/active-work";
import { WorkMapBubble } from "../../src/components/WorkMapBubble";

function worker(
  id: string,
  label: string,
  state: FleetNode["state"],
): FleetNode {
  return {
    id,
    jobId: `job-${id}`,
    label,
    agent: "maya",
    repository: "daniels-project-space/jarvis",
    state,
    status: state === "queued" ? "pending" : "running",
    stage: "fixture validation",
    percent: 55,
    progress: "Fixture work is actively projected",
    progressAt: 1,
    model: "terra",
    reasoningEffort: "high",
    modelReason: "local fixture",
    workerRuntime: "trigger",
    workerRunId: `run-${id}`,
    generation: 1,
    attempt: 1,
    maxAttempts: 2,
    dependencyCount: 0,
    dependenciesReady: 0,
    integrationState: "not_applicable",
    deliveryStatus: null,
    mergeState: "not started",
    recoverySummary: null,
    needsDaniel: false,
    attentionReason: null,
    controls: ["pause"],
    startedAt: 1,
  };
}

const workers = [
  worker("marketing", "Marketing · Campaign QA", "running"),
  worker("business", "Business · Revenue review", "reviewing"),
  worker("research", "Research · Market audit", "queued"),
  worker("operations", "Operations · Deploy check", "integrating"),
];

const snapshot: CompactWorkSnapshot = {
  active: {
    id: "job-marketing",
    missionId: "fixture-work-map",
    label: "Fixture work map",
    status: "running",
    stage: "fixture validation",
    percent: 55,
    extraCount: 3,
    needsDaniel: false,
  },
  fleet: {
    id: "fixture-work-map",
    goal: "Validate the bounded work map",
    mode: "goal",
    status: "running",
    phase: "fixture validation",
    percent: 55,
    repository: "daniels-project-space/jarvis",
    planDigest: null,
    planGeneration: 1,
    integrationState: "building",
    attentionCount: 0,
    controls: ["pause"],
    nodes: workers,
    edges: [],
  },
  hierarchy: [{
    id: "fixture-work-map",
    label: "Validate the bounded work map",
    status: "running",
    phase: "fixture validation",
    projects: [{
      id: "fixture-project-jarvis",
      canonicalProjectId: "jarvis",
      repository: "daniels-project-space/jarvis",
      jobs: workers,
    }],
  }],
};

const reduceMotion = new URLSearchParams(window.location.search).get("reduced") === "1";
document.documentElement.classList.toggle("jarvis-reduce-motion", reduceMotion);

function WorkMapFixture() {
  return (
    <main
      data-work-map-fixture
      aria-label="Jarvis work map fixture"
      style={{ background: "#05070d", height: "100dvh", overflow: "hidden", position: "relative", width: "100vw" }}
    >
      <WorkMapBubble
        snapshot={snapshot}
        owner
        documentCount={3}
        reduceMotion={reduceMotion}
        onOpenDocumentsAction={() => undefined}
        onOpenTodosAction={() => undefined}
        onOpenWorkAction={() => undefined}
        onOpenAllWorkAction={() => undefined}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Work-map fixture root is missing.");

createRoot(root).render(<WorkMapFixture />);
