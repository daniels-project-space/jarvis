import { describe, expect, it } from "vitest";
import { routeDirectAgentLaunch } from "./direct-agent-routing";

describe("direct foreground agent launch routing", () => {
  it.each([
    {
      name: "bounded research",
      task: "Research the bounded current primary sources and summarize exact evidence",
      input: { agentId: "atlas", readonly: true, tools: ["context7"] },
      expected: { agentId: "atlas", model: "luna", reasoningEffort: "medium" },
      reason: /Bounded research specialist/,
    },
    {
      name: "explicit structured floor",
      task: "Apply the deterministic bounded rename in one file",
      input: { agentId: "paul", model: "terra", reasoningEffort: "high", repo: "jarvis" },
      expected: { agentId: "paul", model: "terra", reasoningEffort: "high" },
      reason: /requested Terra\/high floor/,
    },
    {
      name: "production security safety floor",
      task: "Repair production authentication and customer privacy isolation",
      input: { agentId: "paul", model: "luna", reasoningEffort: "low", repo: "jarvis" },
      expected: { agentId: "paul", model: "sol", reasoningEffort: "max" },
      reason: /Security\/privacy safety floor/,
    },
  ])("routes $name through the shared deterministic policy", ({ task, input, expected, reason }) => {
    const selection = routeDirectAgentLaunch(task, input);
    expect(selection.agentId).toBe(expected.agentId);
    expect(selection.route).toMatchObject(expected);
    expect(selection.route.modelReason).toMatch(reason);
  });
});
