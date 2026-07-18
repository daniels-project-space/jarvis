import { describe, expect, it } from "vitest";
import { parseFastAgentDispatch } from "./fast-agent-dispatch";

describe("parseFastAgentDispatch", () => {
  it("routes an explicit named specialist launch without a model turn", () => {
    expect(parseFastAgentDispatch("Launch Paul to fix the continuous voice capture bug")).toEqual({
      task: "fix the continuous voice capture bug",
      agentId: "paul",
    });
  });

  it("lets deterministic routing choose an unnamed specialist", () => {
    expect(parseFastAgentDispatch("Can you assign an agent to research the current UK rental market?"))
      .toEqual({ task: "research the current UK rental market?", agentId: undefined });
  });

  it.each([
    "Should we launch an agent?",
    "Launch an agent to fix it",
    "Launch agents to audit all projects",
    "Ask the team to investigate this",
  ])("keeps contextual or fleet requests with Jarvis: %s", (input) => {
    expect(parseFastAgentDispatch(input)).toBeNull();
  });
});
