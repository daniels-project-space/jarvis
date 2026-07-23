import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { planManagedMission } from "./supervisor";

describe("managed mission workflow", () => {
  it("runs explicit workstreams through the committed Mastra graph", async () => {
    const plan = await planManagedMission("Upgrade Jarvis with independent engineering and creative work", {
      repo: "jarvis",
      context: "Keep the foreground conversation available while specialists work.",
      workstreams: [
        { label: "Runtime", task: "Refactor the multi-file orchestration backend and run its tests", agentId: "paul" },
        { label: "Visual system", task: "Illustrate an editable visual system for the command deck", agentId: "iris", readonly: true },
      ],
    });

    expect(plan.plannedBy).toBe("mastra");
    expect(plan.context).toContain("foreground conversation");
    expect(plan.workstreams).toHaveLength(2);
    expect(plan.workstreams.map((stream) => stream.agentId)).toEqual(["paul", "iris"]);
    expect(plan.workstreams.every((stream) => stream.acceptanceCriteria.length > 0)).toBe(true);
    expect(plan.workstreams.every((stream) => Boolean(stream.reasoningEffort && stream.modelReason))).toBe(true);
  });

  it("deduplicates identical leases before enqueue", async () => {
    const duplicate = { label: "Audit", task: "Research current primary sources for the architecture", agentId: "atlas" };
    const plan = await planManagedMission("Research the architecture with a bounded evidence review", {
      workstreams: [duplicate, duplicate],
    });

    expect(plan.plannedBy).toBe("mastra");
    expect(plan.workstreams).toHaveLength(1);
    expect(plan.workstreams[0]).toMatchObject({ agentId: "atlas", model: "luna" });
    expect(["medium", "high"]).toContain(plan.workstreams[0].reasoningEffort);
    expect(plan.workstreams[0].modelReason).toMatch(/research/i);
  });

  it("cannot weaken the approval gate for consequential work", async () => {
    const plan = await planManagedMission("Prepare one carefully gated customer action", {
      workstreams: [
        {
          label: "Customer reply",
          task: "Send the customer a rental reply",
          agentId: "atlas",
          readonly: false,
          approvalRequired: false,
          risk: "low",
        },
      ],
    });

    expect(plan.plannedBy).toBe("mastra");
    expect(plan.workstreams[0]).toMatchObject({
      approvalRequired: true,
      readonly: true,
      risk: "consequential",
      model: "sol",
      reasoningEffort: "max",
    });
  });

  it("preserves an explicit effort floor through both Mastra routing passes", async () => {
    const plan = await planManagedMission("Apply one bounded implementation repair", {
      repo: "jarvis",
      workstreams: [{
        label: "Exact repair",
        task: "Apply the routine deterministic rename in one file",
        agentId: "paul",
        model: "luna",
        reasoningEffort: "high",
      }],
    });

    expect(plan.workstreams[0]).toMatchObject({
      agentId: "paul",
      model: "luna",
      reasoningEffort: "high",
    });
    expect(plan.workstreams[0].modelReason).toMatch(/requested Luna\/high floor/);
  });
});
