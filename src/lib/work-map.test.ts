import { describe, expect, it } from "vitest";
import type { CompactWorkSnapshot, FleetNode } from "./active-work";
import {
  buildWorkMap,
  isWorkMapNodeWorking,
  shouldHideWorkMap,
  selectContextualWorkMapCategories,
  workMapActiveJobCount,
  workMapPosition,
  WORK_MAP_MAX_LEAVES,
} from "./work-map";

const node = (overrides: Partial<FleetNode> = {}): FleetNode => ({
  id: "node-1", jobId: "job-1", label: "Marketing · Draft launch campaign", agent: "maya",
  repository: "daniels-project-space/media-engine", state: "running", status: "running", stage: "writing",
  percent: 44, progress: "Drafting campaign narrative", progressAt: 80, model: "terra", reasoningEffort: "high",
  modelReason: "bounded task", workerRuntime: "trigger", workerRunId: "run-1", generation: 1, attempt: 1,
  maxAttempts: 3, dependencyCount: 0, dependenciesReady: 0, integrationState: "not_applicable",
  deliveryStatus: null, mergeState: "not started", recoverySummary: null, needsDaniel: false,
  attentionReason: null, controls: ["pause"], startedAt: 1, ...overrides,
});

function snapshot(nodes: FleetNode[]): CompactWorkSnapshot {
  return {
    active: { id: nodes[0]?.jobId ?? "", missionId: "mission-1", label: "Launch work", status: "running", stage: "building", percent: 40, extraCount: Math.max(0, nodes.length - 1), needsDaniel: false },
    fleet: {
      id: "mission-1", goal: "Launch the next release", mode: "goal", status: "running", phase: "building", percent: 40,
      repository: "daniels-project-space/jarvis", planDigest: null, planGeneration: 1, integrationState: "building",
      attentionCount: 0, controls: ["pause"], nodes, edges: [],
    },
    hierarchy: [{
      id: "mission-1", label: "Launch the next release", status: "running", phase: "building",
      projects: [{ id: "project-media", canonicalProjectId: "media-engine", repository: "daniels-project-space/media-engine", jobs: nodes }],
    }],
  };
}

describe("work map projection", () => {
  it("keeps General useful with real document and Hub to-do counts", () => {
    const map = buildWorkMap(snapshot([]), {
      documentCount: 7,
      todos: { state: "ready", openTodoCount: 3, items: [] },
    });
    const general = map[0];

    expect(general).toMatchObject({ id: "general", label: "General" });
    expect(general.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "general:documents", detail: "7 saved items", action: "documents" }),
      expect.objectContaining({ id: "general:todos", detail: "3 open items", action: "todos" }),
    ]));
  });

  it("derives worker leaves from the durable hierarchy, caps visual leaves, and preserves every job id", () => {
    const nodes = Array.from({ length: WORK_MAP_MAX_LEAVES + 2 }, (_, index) => node({
      id: `node-${index}`,
      jobId: `job-${index}`,
      label: `Jarvis · Marketing task ${index}`,
      progressAt: 100 - index,
    }));
    const map = buildWorkMap(snapshot(nodes));
    const projects = map.find((category) => category.id === "projects")!;
    const project = projects.branches[0];

    expect(project.children).toHaveLength(WORK_MAP_MAX_LEAVES);
    expect(project.hiddenCount).toBe(2);
    expect(project.children.map((leaf) => leaf.jobId)).toEqual(["job-0", "job-1", "job-2", "job-3"]);
    expect(project.working).toBe(true);
  });

  it("adds only populated work domains and gives an actual working worker the green-state signal", () => {
    const map = buildWorkMap(snapshot([
      node({ id: "marketing", jobId: "marketing", label: "Create marketing campaign", state: "running" }),
      node({ id: "business", jobId: "business", label: "Review rental booking revenue", state: "reviewing" }),
      node({ id: "research", jobId: "research", label: "Research a new supplier", state: "queued" }),
      node({ id: "ops", jobId: "ops", label: "Ship product fix", state: "paused" }),
    ]));

    expect(map.map((category) => category.id)).toEqual(expect.arrayContaining(["projects", "marketing", "business", "research", "operations"]));
    expect(map.find((category) => category.id === "marketing")?.branches[0]).toMatchObject({ jobId: "marketing", working: true });
    expect(map.find((category) => category.id === "research")?.branches[0]).toMatchObject({ jobId: "research", working: false });
    expect(isWorkMapNodeWorking(node({ state: "integrating" }))).toBe(true);
    expect(isWorkMapNodeWorking(node({ state: "paused" }))).toBe(false);
  });

  it("counts each durable job once even when it appears in project and domain branches", () => {
    const durableSnapshot = snapshot([node({ jobId: "shared-job", id: "shared-job" })]);
    const map = buildWorkMap(durableSnapshot);

    expect(map.filter((category) => category.id === "projects" || category.id === "marketing")
      .reduce((count, category) => count + category.workCount, 0)).toBe(2);
    expect(workMapActiveJobCount(durableSnapshot)).toBe(1);
  });

  it("yields the work map to chat, voice, research, caption, and stage surfaces", () => {
    const unobstructed = {
      chatMode: "bar" as const,
      live: "off" as const,
      optionsOpen: false,
      stagePanelOpen: false,
      commandExpanded: false,
      hasBubbles: false,
      hasCaption: false,
      researching: false,
      recording: false,
      speaking: false,
      hasActiveVideo: false,
    };

    expect(shouldHideWorkMap(unobstructed)).toBe(false);
    expect(shouldHideWorkMap({ ...unobstructed, chatMode: "full" })).toBe(true);
    expect(shouldHideWorkMap({ ...unobstructed, live: "connecting" })).toBe(true);
    expect(shouldHideWorkMap({ ...unobstructed, live: "live" })).toBe(true);
    ([
      "optionsOpen",
      "stagePanelOpen",
      "commandExpanded",
      "hasBubbles",
      "hasCaption",
      "researching",
      "recording",
      "speaking",
      "hasActiveVideo",
    ] as const).forEach((key) => {
      expect(shouldHideWorkMap({ ...unobstructed, [key]: true })).toBe(true);
    });
  });

  it("keeps root categories out of the expansion strip and in bounded map coordinates", () => {
    for (let total = 1; total <= 6; total += 1) {
      for (let index = 0; index < total; index += 1) {
        const point = workMapPosition(index, total);
        expect(point.x).toBeGreaterThanOrEqual(10);
        expect(point.x).toBeLessThanOrEqual(90);
        expect(point.y).toBeLessThan(66);
      }
    }
  });

  it("shows only the small set of categories adjacent to the current turn", () => {
    const map = buildWorkMap(snapshot([
      node({ jobId: "marketing", label: "Plan marketing launch", state: "queued" }),
      node({ jobId: "research", label: "Research studio references", state: "running" }),
      node({ jobId: "operations", label: "Deploy release", state: "queued" }),
    ]), { documentCount: 4 });

    const contextual = selectContextualWorkMapCategories(map, "find the studio research project", 2);
    expect(contextual).toHaveLength(2);
    expect(contextual[0]?.id).toBe("research");
    expect(contextual.map((category) => category.id)).not.toContain("marketing");
  });

  it.each([375, 390, 540])("keeps all root chips separate in a %ipx phone viewport", (viewportWidth) => {
    // Below sm, category chips use min(98px, 24vw). These bounds reflect the
    // actual map surface with an additional stage-side safety gutter and a
    // conservative rendered chip height, catching accidental geometry
    // regressions without a browser.
    const mapWidth = viewportWidth - 36;
    const mapHeight = 510;
    const chipWidth = Math.min(98, viewportWidth * 0.24);
    const chipHeight = 52;

    for (let total = 1; total <= 6; total += 1) {
      const points = Array.from({ length: total }, (_, index) => workMapPosition(index, total));
      points.forEach((point) => {
        const x = mapWidth * point.x / 100;
        const y = mapHeight * point.y / 100;
        expect(x - chipWidth / 2).toBeGreaterThanOrEqual(0);
        expect(x + chipWidth / 2).toBeLessThanOrEqual(mapWidth);
        expect(y - chipHeight / 2).toBeGreaterThanOrEqual(0);
        expect(y + chipHeight / 2).toBeLessThanOrEqual(mapHeight);
      });
      for (let left = 0; left < points.length; left += 1) {
        for (let right = left + 1; right < points.length; right += 1) {
          const horizontalDistance = Math.abs(points[left].x - points[right].x) * mapWidth / 100;
          const verticalDistance = Math.abs(points[left].y - points[right].y) * mapHeight / 100;
          expect(horizontalDistance >= chipWidth || verticalDistance >= chipHeight).toBe(true);
        }
      }
    }
  });
});
