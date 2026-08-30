import { createRoot } from "react-dom/client";
import { FleetCommandCenter } from "../../src/components/CompactWorkBar";
import type { CompactJobDetail, CompactWorkSnapshot, FleetNode } from "../../src/lib/active-work";

function worker(
  id: string,
  label: string,
  state: FleetNode["state"],
  overrides: Partial<FleetNode> = {},
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
    workerRunId: null,
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
    ...overrides,
  };
}

const workers = [
  worker("approval", "Approval gate", "needs_input", {
    agent: "chloe",
    needsDaniel: true,
    attentionReason: "Choose the production cap",
    controls: ["cancel", "provide_input"],
  }),
  worker("validation", "Live validation", "running", { agent: "paul" }),
  worker("queued", "Queued background task", "queued", { agent: "maya" }),
  worker("held", "Held follow-up", "dependency_held", { agent: "atlas" }),
];

const snapshot: CompactWorkSnapshot = {
  active: {
    id: "job-approval",
    missionId: "fixture-compact-work",
    label: "Bound the compact work surface",
    status: "needs_input",
    stage: "fixture validation",
    percent: 55,
    extraCount: 3,
    needsDaniel: true,
  },
  fleet: {
    id: "fixture-compact-work",
    goal: "Validate bounded compact work",
    mode: "goal",
    status: "running",
    phase: "fixture validation",
    percent: 55,
    repository: "daniels-project-space/jarvis",
    planDigest: null,
    planGeneration: 1,
    integrationState: "building",
    attentionCount: 1,
    controls: ["pause"],
    nodes: workers,
    edges: [],
  },
  hierarchy: [{
    id: "fixture-compact-work",
    label: "Validate bounded compact work",
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

const approvalDetail: CompactJobDetail = {
  jobId: "job-approval",
  status: "needs_input",
  attempt: 1,
  stage: "fixture validation",
  percent: 55,
  progress: "Choose the production cap",
  sourceBranch: "agent/fixture-approval",
  sourceHeadSha: null,
  integrationBranch: "main",
  workerBranch: "agent/fixture-approval",
  branch: "agent/fixture-approval",
  mergeCommitSha: null,
  label: "Approval gate",
  agentId: "chloe",
  repo: "daniels-project-space/jarvis",
  progressAt: 1,
  model: "terra",
  reasoningEffort: "high",
  modelReason: "local fixture",
  workerRuntime: "trigger",
  workerRunId: null,
  generation: 1,
  maxAttempts: 2,
  integrationState: "not_applicable",
  deliveryStatus: null,
  startedAt: 1,
  stallReason: null,
};

function CompactWorkFixture() {
  return (
    <main
      aria-label="Jarvis compact work fixture"
      style={{ background: "#05070d", height: "100dvh", overflow: "hidden", position: "relative", width: "100vw" }}
    >
      <FleetCommandCenter snapshot={snapshot} detail={approvalDetail} />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Compact-work fixture root is missing.");

createRoot(root).render(<CompactWorkFixture />);
