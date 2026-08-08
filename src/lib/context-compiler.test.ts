import { describe, expect, it } from "vitest";
import {
  classifyContextProfile,
  compileContext,
  CONTEXT_COMPILER_MAX_CHARS,
} from "./context-compiler";

const input = {
  northStar: "Build a connected portfolio that compounds Daniel's time and judgement.",
  projectRegistry: [
    { slug: "jarvis", name: "Jarvis", vision: "A trusted personal operating brain." },
    { slug: "finance-engine-v2", name: "Finance Engine", vision: "A research-first trading lab." },
  ],
  brain: {
    memory: [
      { kind: "preference", title: "Reply style", body: "Keep spoken replies concise.", source: "chat", confidence: 1 },
      { kind: "decision", title: "Safety", body: "External actions need approval.", source: "obsidian", confidence: 0.95 },
    ],
    projects: [
      { slug: "jarvis", status: "ready", summary: "Assistant", data: { purpose: "Personal operating brain", recent: "Voice lane verified" } },
      { slug: "finance-engine-v2", status: "ready", summary: "Finance", data: { purpose: "Research lab" } },
    ],
    goals: [{ project: "jarvis", title: "Instant replies", status: "active", progress: 40, outcome: "Fast useful replies", nextAction: "Measure first paint" }],
    goalMissions: [{ id: "mission-1", goal: "Make Jarvis reliable", status: "running", phase: "verify", percent: 70 }],
    attention: [{ title: "Approval needed", actionClass: "ask", confidence: 1, detail: "A consequential action is waiting." }],
    approvals: [{ jobId: "job-1", summary: "Publish a deployment" }],
    jobs: [{ agentId: "Atlas", label: "Verify context compiler", stage: "running", percent: 30 }],
    agents: [{ name: "Atlas", status: "working", activeJobCount: 1, role: "Verification" }],
    creations: [{ id: "canvas-1", kind: "board", title: "Portfolio map" }],
    panel: { type: "widget", title: "Portfolio map" },
    trip: {
      _id: "trip-1",
      title: "London",
      data: JSON.stringify({ status: "planning", locked: { flight: "BA" } }),
      updatedAt: Date.now(),
    },
    draft: { title: "Launch note", data: "The complete current draft.", updatedAt: Date.now() },
    location: { title: "Home", value: "London" },
    findings: [{ spoken: "The focused context path is bounded." }],
  },
  hub: {
    todos: [{ text: "Ship context compiler" }],
    events: [{ title: "Review", start: Date.UTC(2026, 7, 8) }],
    wealth: { currentTotalGBP: 123456 },
  },
};

describe("context compiler", () => {
  it("keeps reflex turns intentionally lean", () => {
    const result = compileContext({ ...input, userText: "hello" });
    expect(classifyContextProfile("hello")).toBe("reflex");
    expect(result).toContain("Respond immediately and naturally");
    expect(result).not.toContain("DURABLE OUTCOMES");
    expect(result.length).toBeLessThan(CONTEXT_COMPILER_MAX_CHARS);
  });

  it("assembles a small evidence pack for strategic work", () => {
    const result = compileContext({ ...input, userText: "Compare the Jarvis architecture trade-offs and make a decision" });
    expect(classifyContextProfile("Compare the Jarvis architecture trade-offs")).toBe("strategic");
    expect(result).toContain("RELEVANT MEMORY");
    expect(result).toContain("PORTFOLIO STATE CARDS");
    expect(result).toContain("DURABLE OUTCOMES");
    expect(result).toContain("ATTENTION QUEUE");
    expect(result).toContain("VERIFIED WORK RECEIPTS");
    expect(result.length).toBeLessThanOrEqual(CONTEXT_COMPILER_MAX_CHARS);
  });

  it("does not carry finance and calendar context into unrelated work", () => {
    const result = compileContext({ ...input, userText: "Fix the Jarvis voice interruption" });
    expect(result).not.toContain("WEALTH");
    expect(result).not.toContain("CALENDAR");
  });

  it("keeps active work, trip, draft, and location only when the turn needs them", () => {
    expect(compileContext({ ...input, userText: "What's the progress of the agent mission?" }))
      .toContain("GOAL MODE");
    expect(compileContext({ ...input, userText: "What's the progress of the agent mission?" }))
      .toContain("PERMANENT TEAM");
    expect(compileContext({ ...input, userText: "What flight did we lock for the trip?" }))
      .toContain("TRIP IN PROGRESS");
    expect(compileContext({ ...input, userText: "Make the draft warmer" }))
      .toContain("The complete current draft");
    expect(compileContext({ ...input, userText: "What's the weather near me?" }))
      .toContain("LIVE LOCATION");
    expect(compileContext({ ...input, userText: "Explain the Jarvis architecture" }))
      .not.toContain("TRIP IN PROGRESS");
  });

  it("preserves ranking identities for on-screen number follow-ups", () => {
    const result = compileContext({
      ...input,
      userText: "Tell me more about the second one on screen",
      brain: {
        ...input.brain,
        panel: {
          type: "widget",
          value: JSON.stringify({
            kind: "ranking",
            title: "Candidates",
            items: [{ rank: 1, name: "Ada" }, { rank: 2, name: "Grace" }],
          }),
        },
      },
    });
    expect(result).toContain("#1 Ada");
    expect(result).toContain("#2 Grace");
    expect(result.indexOf("DISPLAY CONTEXT")).toBeLessThan(result.indexOf("RELEVANT MEMORY"));
  });
});
