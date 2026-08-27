import { describe, expect, it } from "vitest";
import {
  classifyContextProfile,
  compileContext,
  CONTEXT_COMPILER_MAX_CHARS,
  requiresHubSnapshot,
} from "./context-compiler";

const now = Date.now();

const input = {
  northStar: "Build a connected portfolio that compounds Daniel's time and judgement.",
  projectRegistry: [
    { slug: "jarvis", name: "Jarvis", vision: "A trusted personal operating brain." },
    { slug: "finance-engine-v2", name: "Finance Engine", vision: "A research-first trading lab." },
  ],
  brain: {
    currentState: [{ key: "profile.current_location", value: "Sevilla", observedAt: now, confidence: 0.99 }],
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
    business: [
      { domain: "youtube", headline: "YouTube: 1 channel, 12,345 subscribers, 678,900 total views.", detail: "2 recent uploads; 1 active pipeline run." },
      { domain: "ads", headline: "Ads: £320 spent this month, 14 qualified leads.", detail: "Media Engine campaign is running." },
      { domain: "rental", headline: "Rentals: £4,500 earned this month.", detail: "3 active rentals." },
      { domain: "music", headline: "Music (DistroKid): £120 balance, 44,000 total streams." },
    ],
    creations: [{ id: "canvas-1", kind: "board", title: "Portfolio map" }],
    panel: { type: "widget", title: "Portfolio map" },
    trip: {
      _id: "trip-1",
      title: "London",
      data: JSON.stringify({ status: "planning", locked: { flight: "BA" } }),
      updatedAt: now,
    },
    draft: { title: "Launch note", data: "The complete current draft.", updatedAt: now },
    location: { title: "London", value: "51.50740,-0.12780", updatedAt: now - 1_000 },
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
    const result = compileContext({ ...input, userText: "hello, Jarvis!" });
    expect(classifyContextProfile("hello, Jarvis!")).toBe("reflex");
    expect(classifyContextProfile("Hey Jarvis, what's on my calendar?")).toBe("focused");
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
    expect(result).not.toContain("BUSINESS STATE");
  });

  it("only requests the Project Hub snapshot for turns whose compiler branch can use it", () => {
    expect(requiresHubSnapshot("Fix the Jarvis voice interruption")).toBe(false);
    expect(requiresHubSnapshot("How is the Media Engine advertising campaign doing?")).toBe(false);
    expect(requiresHubSnapshot("What's on my calendar tomorrow?")).toBe(true);
    expect(requiresHubSnapshot("What's our current wealth?")).toBe(true);
  });

  it("routes natural YouTube and media campaign questions to only their relevant business pulse", () => {
    const subscribers = compileContext({ ...input, userText: "How many YouTube subscribers do we have?" });
    expect(subscribers).toContain("BUSINESS STATE");
    expect(subscribers).toContain("12,345 subscribers");
    expect(subscribers).not.toContain("£4,500 earned");
    expect(subscribers).not.toContain("WEALTH");

    const campaign = compileContext({ ...input, userText: "How is the Media Engine advertising campaign doing?" });
    expect(campaign).toContain("12,345 subscribers");
    expect(campaign).toContain("£320 spent this month");
    expect(campaign).not.toContain("£4,500 earned");
    expect(campaign).not.toContain("WEALTH");
  });

  it("does not treat a media-file implementation request as a business pulse request", () => {
    const result = compileContext({ ...input, userText: "Fix the media file upload flow" });
    expect(result).not.toContain("BUSINESS STATE");
    expect(result).not.toContain("WEALTH");
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
      .toContain("CURRENT SITUATION");
    expect(compileContext({ ...input, userText: "Explain the Jarvis architecture" }))
      .not.toContain("TRIP IN PROGRESS");
  });

  it("grounds the exact real-world Sevilla map request in current state", () => {
    const result = compileContext({
      ...input,
      userText: "I'm in Sevilla right now, can you show me a map with some attractions in the city?",
    });
    expect(result).toContain("CURRENT SITUATION");
    expect(result).toContain("current location is Sevilla");
    expect(result).toContain("default map, weather, route, and nearby-search origin");
  });

  it("uses the newest fresh device location and never carries a stale one forward", () => {
    const freshDevice = compileContext({
      ...input,
      userText: "Show nearby places on a map",
      brain: {
        ...input.brain,
        currentState: [{ key: "profile.current_location", value: "Sevilla", observedAt: now - 10_000 }],
        location: { title: "Camden", value: "51.53900,-0.14200", updatedAt: now },
      },
    });
    expect(freshDevice).toContain("LIVE LOCATION");
    expect(freshDevice).toContain("Camden");
    expect(freshDevice).not.toContain("current location is Sevilla");

    const stale = compileContext({
      ...input,
      userText: "Show nearby places on a map",
      brain: {
        ...input.brain,
        currentState: [{ key: "profile.current_location", value: "Old Sevilla", observedAt: now - 13 * 60 * 60_000 }],
        location: { title: "Old London", value: "51.50740,-0.12780", updatedAt: now - 16 * 60_000 },
      },
    });
    expect(stale).not.toContain("CURRENT SITUATION");
    expect(stale).not.toContain("LIVE LOCATION");
  });

  it("grounds a city turn in the exact live workspace and its fresh booked stay", () => {
    const result = compileContext({
      ...input,
      userText: "Show attractions in Sevilla and add them to day one",
      brain: {
        ...input.brain,
        activeTravel: {
          draftId: "draft-sevilla-1",
          destination: "Sevilla",
          departDate: "2026-09-12",
          returnDate: "2026-09-16",
          planRevision: 3,
          itinerary: [{
            date: "2026-09-12",
            items: [{ title: "Alcázar", time: "10:00", durationMinutes: 90, kind: "activity" }],
            route: { mode: "walking", status: "ready", durationSeconds: 720, distanceMeters: 700 },
          }],
          discoveries: [{ city: "Sevilla", query: "attractions", itemCount: 5, route: { mode: "walking", status: "ready", durationSeconds: 900 } }],
          bookingReferences: [{
            city: "Sevilla",
            title: "Riverside Apartments",
            bookingName: "Riverside Apartments",
            location: "42 Calle del Agua, Sevilla",
            start: now - 3_600_000,
            end: now + 86_400_000,
            verifiedAt: now - 60_000,
            timeZone: "Europe/Madrid",
            distanceKm: 0.8,
          }],
        },
      },
    });
    expect(result).toContain("LIVE TRAVEL WORKSPACE");
    expect(result).toContain("draft_id=draft-sevilla-1");
    expect(result).toContain("Alcázar");
    expect(result).toContain("BOOKED STAY REFERENCE");
    expect(result).toContain("Riverside Apartments");

    const staleBooking = compileContext({
      ...input,
      userText: "Show attractions in Sevilla",
      brain: {
        ...input.brain,
        activeTravel: {
          draftId: "draft-sevilla-1",
          destination: "Sevilla",
          bookingReferences: [{
            city: "Sevilla",
            bookingName: "Expired verification",
            location: "42 Calle del Agua, Sevilla",
            start: now - 3_600_000,
            end: now + 86_400_000,
            verifiedAt: now - 24 * 60 * 60_000 - 1,
          }],
        },
      },
    });
    expect(staleBooking).not.toContain("BOOKED STAY REFERENCE");
    expect(staleBooking).not.toContain("Expired verification");
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
