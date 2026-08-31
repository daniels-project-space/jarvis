import { describe, expect, it } from "vitest";
import { parseFastAgentDispatch, parseFastGoalCrewDispatch, parseProjectFeatureDispatch } from "./fast-agent-dispatch";

describe("parseFastAgentDispatch", () => {
  it("routes an explicit named specialist launch without a model turn", () => {
    expect(parseFastAgentDispatch("Launch Paul to fix the continuous voice capture bug")).toEqual({
      task: "fix the continuous voice capture bug",
      agentId: "paul",
    });
  });

  it("accepts the spoken Start Atlas phrasing used for the read-only worker smoke", () => {
    expect(parseFastAgentDispatch("Start Atlas to research open-source speech systems."))
      .toEqual({
        task: "research open-source speech systems.",
        agentId: "atlas",
      });
  });

  it("recognises Chloe as a real named employee in voice dispatch", () => {
    expect(parseFastAgentDispatch("Ask Chloe to prepare next week's social content calendar"))
      .toEqual({
        task: "prepare next week's social content calendar",
        agentId: "chloe",
      });
  });

  it("lets deterministic routing choose an unnamed specialist", () => {
    expect(parseFastAgentDispatch("Can you assign an agent to research the current UK rental market?"))
      .toEqual({ task: "research the current UK rental market?", agentId: undefined });
  });

  it("attaches the canonical Jarvis repository to an explicit Jarvis task", () => {
    expect(parseFastAgentDispatch("Launch an agent to audit the current Jarvis work map for stale tasks"))
      .toEqual({
        task: "audit the current Jarvis work map for stale tasks",
        agentId: undefined,
        repo: "daniels-project-space/jarvis",
      });
  });

  it("keeps an explicitly cross-project handoff out of the singular fast lane", () => {
    expect(parseFastAgentDispatch("Launch Paul to repair the connection between Jarvis and Project Hub"))
      .toBeNull();
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

describe("parseFastGoalCrewDispatch", () => {
  it("turns the spoken profitability outcome into a measured crew start", () => {
    expect(parseFastGoalCrewDispatch("Make my Snuffelo Shopify website profitable")).toMatchObject({
      goal: "Make my Snuffelo Shopify website profitable",
      successMetric: expect.stringContaining("net contribution profit"),
      target: expect.stringContaining("positive reconciled net contribution profit"),
    });
  });

  it("recognizes explicit team and completion-loop commands", () => {
    expect(parseFastGoalCrewDispatch("Start a team to rigorously improve the store until the measured target is met"))
      .toMatchObject({ goal: expect.stringContaining("Start a team") });
    expect(parseFastGoalCrewDispatch("Keep working on the launch until every production journey passes"))
      .toMatchObject({ goal: expect.stringContaining("until every production journey passes") });
  });

  it("keeps exploratory questions and ordinary feature work conversational", () => {
    expect(parseFastGoalCrewDispatch("How should I make my Shopify store profitable?")).toBeNull();
    expect(parseFastGoalCrewDispatch("Add a compact worker card to Jarvis")).toBeNull();
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
