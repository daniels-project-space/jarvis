import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CompactWorkSnapshot, FleetNode } from "@/lib/active-work";
import { WorkMapBubble } from "./WorkMapBubble";

vi.mock("@/lib/viewer-request", () => ({ viewerFetch: vi.fn() }));

const node: FleetNode = {
  id: "node", jobId: "job-map", label: "Marketing · Run campaign checks", agent: "maya", repository: "daniels-project-space/media-engine",
  state: "running", status: "running", stage: "testing", percent: 57, progress: "Checking delivery", progressAt: 1,
  model: "terra", reasoningEffort: "high", modelReason: "bounded", workerRuntime: "trigger", workerRunId: "run-map",
  generation: 1, attempt: 1, maxAttempts: 2, dependencyCount: 0, dependenciesReady: 0, integrationState: "not_applicable",
  deliveryStatus: null, mergeState: "not started", recoverySummary: null, needsDaniel: false, attentionReason: null,
  controls: ["pause"], startedAt: 1,
};
const snapshot: CompactWorkSnapshot = {
  active: { id: "job-map", missionId: "mission", label: node.label, status: "running", stage: "testing", percent: 57, extraCount: 0, needsDaniel: false },
  fleet: { id: "mission", goal: "Launch work", mode: "goal", status: "running", phase: "testing", percent: 57, repository: node.repository, planDigest: null, planGeneration: 1, integrationState: "building", attentionCount: 0, controls: ["pause"], nodes: [node], edges: [] },
  hierarchy: [{ id: "mission", label: "Launch work", status: "running", phase: "testing", projects: [{ id: "media", canonicalProjectId: "media-engine", repository: node.repository, jobs: [node] }] }],
};
const actions = { onOpenDocumentsAction: vi.fn(), onOpenTodosAction: vi.fn(), onOpenWorkAction: vi.fn(), onOpenAllWorkAction: vi.fn() };

describe("WorkMapBubble", () => {
  it("stays as a tiny bubble until Daniel opens it", () => {
    const markup = renderToStaticMarkup(<WorkMapBubble snapshot={snapshot} owner documentCount={3} {...actions} />);
    expect(markup).toContain("data-work-map-trigger");
    expect(markup).toContain("1 active worker task");
    expect(markup).not.toContain("data-work-map=\"true\"");
  });

  it("renders a real constrained SVG/DOM topology with category controls, working leaf affordances, and no canvas", () => {
    const markup = renderToStaticMarkup(<WorkMapBubble snapshot={snapshot} owner initialOpen documentCount={3} reduceMotion {...actions} />);
    expect(markup).toContain("data-work-map=\"true\"");
    expect(markup).toContain("contextual Jarvis work map");
    expect(markup).toContain("data-work-map-category=\"general\"");
    expect(markup).toContain("data-work-map-category=\"projects\"");
    expect(markup).toContain("data-work-map-category=\"marketing\"");
    expect(markup).toContain("work-map-pulse");
    expect(markup).toContain("work-map-static");
    expect(markup).not.toContain("<canvas");
  });

  it("never renders owner work topology for a guest", () => {
    expect(renderToStaticMarkup(<WorkMapBubble snapshot={snapshot} owner={false} {...actions} />)).toBe("");
  });
});
