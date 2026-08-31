import { describe, expect, it } from "vitest";
import { searchOrbSurfaces } from "./orb-quick-search";

describe("orb quick search", () => {
  it("keeps results small, relevant, and action-safe", () => {
    const results = searchOrbSurfaces("rental", {
      projects: [{ slug: "rental-manager-v2", name: "Rental Manager", status: "healthy", productionUrl: "https://example.test" }],
      creations: [{ _id: "creation-1", title: "Rental pricing brief", kind: "doc", category: "documents", folder: "Projects / Rental" }],
      files: [{ fileId: "file-1", name: "rental-revenue.pdf", relativePath: "finance/rental-revenue.pdf", mimeType: "application/pdf", status: "ready" }],
      memories: [{ _id: "memory-1", title: "Rental pricing decision", body: "Keep availability evidence current", kind: "decision", tags: ["rental"] }],
      hub: [{ id: "hub:todo:1", kind: "todo", title: "Review rental targets", detail: "Project Hub to-do", target: "todo" }],
      jobs: [{ jobId: "job-1", label: "Audit rental availability", agent: "atlas", repository: "daniels-project-space/rental-manager-v2", state: "running", status: "running", stage: "checking", percent: 20, progress: "Checking real availability", progressAt: 1, model: "terra", reasoningEffort: "high", modelReason: "bounded", workerRuntime: "trigger", workerRunId: "run-1", generation: 1, attempt: 1, maxAttempts: 1, dependencyCount: 0, dependenciesReady: 0, integrationState: "not_applicable", deliveryStatus: null, mergeState: "not started", recoverySummary: null, needsDaniel: false, attentionReason: null, controls: [], startedAt: 1, id: "job-1" }],
    });

    expect(results.map((result) => result.source)).toEqual(expect.arrayContaining(["project", "creation", "file", "work", "memory", "hub"]));
    expect(results.find((result) => result.source === "file")).toMatchObject({ canShow: true });
    expect(results.every((result) => !JSON.stringify(result).includes("r2Key"))).toBe(true);
    expect(results).toHaveLength(6);
  });

  it("does not expose an unbounded browse surface before there is a query", () => {
    expect(searchOrbSurfaces(" ", { projects: [{ slug: "jarvis", name: "Jarvis" }] })).toEqual([]);
    expect(searchOrbSurfaces("j", { projects: [{ slug: "jarvis", name: "Jarvis" }] })).toEqual([]);
  });
});
