import { FleetCommandCenter } from "@/components/CompactWorkBar";
import ThreeOrb from "@/components/ThreeOrb";
import type { CompactWorkSnapshot, FleetNode } from "@/lib/active-work";

const states: FleetNode["state"][] = ["done", "done", "running", "dependency_held", "reviewing", "integrating", "needs_input", "queued"];
const labels = ["Projection contract", "Responsive shell", "DAG relationships", "Realtime handoff", "Focused validation", "Repository integration", "Decision boundary", "Final evidence"];
const agents = ["atlas", "iris", "paul", "maya", "sentry", "atlas", "jarvis", "paul"];

const nodes: FleetNode[] = labels.map((label, index) => ({
  id: `node-${index + 1}`, jobId: `job-${index + 1}`, label, agent: agents[index],
  repository: index < 6 ? "daniels-project-space/jarvis" : "daniels-project-space/project-hub",
  state: states[index], status: states[index] === "dependency_held" || states[index] === "queued" ? "pending" : states[index] === "needs_input" ? "needs_input" : states[index] === "done" ? "done" : "running",
  stage: states[index].replace("_", " "), percent: states[index] === "done" ? 100 : 24 + index * 9,
  progress: index === 6 ? "Confirm the integration conflict boundary" : `${label} · meaningful update persisted`,
  progressAt: Date.UTC(2026, 6, 21, 17, 40 + index), model: index === 6 ? "sol" : "terra",
  reasoningEffort: index === 6 ? "max" : "high",
  modelReason: index === 6 ? "Sol/max for a protected integration decision" : "Terra/high for bounded implementation work",
  workerRuntime: "trigger", workerRunId: null,
  generation: index > 4 ? 2 : 1, attempt: index === 5 ? 2 : 1, maxAttempts: 12,
  dependencyCount: index === 0 ? 0 : index < 3 ? 1 : 2, dependenciesReady: index < 3 ? Math.min(index, 1) : index < 6 ? 1 : 2,
  integrationState: states[index] === "integrating" ? "integrating" : states[index] === "needs_input" ? "needs_attention" : "not_applicable",
  deliveryStatus: states[index] === "done" ? "merged" : null, mergeState: states[index] === "done" ? "merged" : states[index] === "integrating" ? "integrating" : "not started",
  recoverySummary: index === 5 ? "Recovered execution · attempt 2" : null, needsDaniel: states[index] === "needs_input",
  attentionReason: states[index] === "needs_input" ? "Integration conflict needs Daniel's repository boundary decision" : null,
  controls: states[index] === "needs_input" ? ["resume", "cancel", "steer"] : states[index] === "running" ? ["pause", "cancel", "steer"] : [], startedAt: Date.UTC(2026, 6, 21, 17, 30),
}));

const snapshot: CompactWorkSnapshot = {
  active: { id: "job-7", missionId: "mission-preview", label: "Decision boundary", status: "needs_input", stage: "needs input", percent: 78, extraCount: 4, needsDaniel: true },
  fleet: {
    id: "mission-preview", goal: "Build the unified live JARVIS fleet surface", mode: "goal", status: "needs_input", phase: "integration", percent: 78,
    repository: "daniels-project-space/jarvis", planDigest: "c7d706a42db3547f3216862c95ef7894e68ac40fbfeae356d03577c8cbb71942", planGeneration: 3,
    integrationState: "integrating", attentionCount: 1, controls: ["resume", "cancel", "steer"], nodes,
    edges: [
      { id: "1-3", source: "node-1", target: "node-3", readiness: "delivered" },
      { id: "2-3", source: "node-2", target: "node-3", readiness: "delivered" },
      { id: "2-4", source: "node-2", target: "node-4", readiness: "ready" },
      { id: "3-5", source: "node-3", target: "node-5", readiness: "waiting" },
      { id: "4-5", source: "node-4", target: "node-5", readiness: "waiting" },
      { id: "5-6", source: "node-5", target: "node-6", readiness: "ready" },
      { id: "6-7", source: "node-6", target: "node-7", readiness: "blocked" },
      { id: "7-8", source: "node-7", target: "node-8", readiness: "waiting" },
    ],
  },
  hierarchy: [{
    id: "mission-preview", label: "Build the unified live JARVIS fleet surface", status: "needs_input", phase: "integration",
    projects: [
      {
        id: "project-preview-jarvis", canonicalProjectId: "jarvis", repository: "daniels-project-space/jarvis",
        jobs: nodes.filter((node) => node.repository === "daniels-project-space/jarvis" && !["done", "dependency_held", "queued"].includes(node.state)),
      },
      {
        id: "project-preview-hub", canonicalProjectId: "project-hub", repository: "daniels-project-space/project-hub",
        jobs: nodes.filter((node) => node.repository === "daniels-project-space/project-hub" && !["done", "dependency_held", "queued"].includes(node.state)),
      },
    ],
  }],
};

export default function FleetVisualPage() {
  return <main className="relative h-dvh overflow-hidden bg-[#030912]">
    <div className="pointer-events-none absolute inset-y-0 left-[61%] right-0 hidden md:block"><ThreeOrb aside reduceMotion /></div>
    <FleetCommandCenter snapshot={snapshot} initialExpanded />
  </main>;
}
