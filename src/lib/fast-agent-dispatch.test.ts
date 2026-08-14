import { describe, expect, it } from "vitest";
import { parseFastAgentDispatch, parseProjectFeatureDispatch } from "./fast-agent-dispatch";

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

describe("parseProjectFeatureDispatch", () => {
  it("starts Paul for a concrete feature request made inside an app", () => {
    expect(parseProjectFeatureDispatch("I want you to add a stem comparison feature to this library"))
      .toEqual({
        task: "I want you to add a stem comparison feature to this library",
        agentId: "paul",
      });
  });

  it("accepts a concrete passive feature request", () => {
    expect(parseProjectFeatureDispatch("I want a waveform comparison feature added to this library"))
      .toEqual({
        task: "I want a waveform comparison feature added to this library",
        agentId: "paul",
      });
  });

  it.each([
    "I want a feature",
    "Show me the library",
    "Fix it",
    "Can you change this",
    "What feature should I add?",
  ])("keeps an underspecified host request in conversation: %s", (input) => {
    expect(parseProjectFeatureDispatch(input)).toBeNull();
  });
});
