import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rows: undefined as unknown,
  recoveries: undefined as unknown,
  calls: [] as Array<{ name?: string; args: unknown }>,
}));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    browserErrands: {
      pending: { _name: "browserErrands:pending" },
      unknownOutcomes: { _name: "browserErrands:unknownOutcomes" },
    },
  },
}));
vi.mock("@/lib/secure-convex", () => ({
  useJarvisQuery: (query: { _name?: string }, args: unknown) => {
    mock.calls.push({ name: query?._name, args });
    return query?._name === "browserErrands:unknownOutcomes" ? mock.recoveries : mock.rows;
  },
}));
vi.mock("@/lib/client-mutation", () => ({ clientMutation: vi.fn() }));

import { BrowserErrandApprovals } from "./BrowserErrandApprovals";

const proposed = {
  _id: "errand-1",
  objective: "Ask support why the refund is delayed",
  status: "proposed" as const,
  plan: ["Open the existing support ticket", "Read its status", "Send one follow-up"],
  executionSteps: [
    { action: "navigate", url: "https://support.example.com/tickets/123" },
    { action: "read", selector: "main", limit: 500 },
    { action: "send", selector: "button[type=submit]" },
  ],
  envelope: {
    allowedHosts: ["support.example.com"],
    allowedActions: ["navigate", "read", "type", "send"],
    maxSends: 1,
    maxSteps: 12,
  },
};

beforeEach(() => {
  mock.rows = [proposed];
  mock.recoveries = [];
  mock.calls = [];
});

describe("BrowserErrandApprovals", () => {
  it("renders the actual stored plan and owner approval choices", () => {
    const markup = renderToStaticMarkup(<BrowserErrandApprovals owner />);

    expect(markup).toContain("Ask support why the refund is delayed");
    expect(markup).toContain("support.example.com");
    expect(markup).toContain("Open the existing support ticket");
    expect(markup).toContain("Exact sealed executable steps (3)");
    expect(markup).toContain("https://support.example.com/tickets/123");
    expect(markup).toContain("Approve exact plan");
    expect(markup).toContain("Decline");
    expect(markup).toContain("does not start the browser by itself");
    expect(mock.calls).toContainEqual({ name: "browserErrands:pending", args: {} });
    expect(mock.calls).toContainEqual({ name: "browserErrands:unknownOutcomes", args: {} });
  });

  it("renders an owner-only unknown-outcome handoff with no retry or approval control", () => {
    mock.rows = [];
    mock.recoveries = [{
      _id: "errand-recovery-1",
      objective: "Follow up on the delayed refund",
    }];

    const markup = renderToStaticMarkup(<BrowserErrandApprovals owner />);

    expect(markup).toContain("browser errand outcome unknown");
    expect(markup).toContain("Follow up on the delayed refund");
    expect(markup).toContain("Its outcome is unknown. JARVIS did not retry it automatically.");
    expect(markup).toContain("Request a fresh exact plan if you still want to proceed.");
    expect(markup).not.toContain("Approve exact plan");
    expect(markup).not.toContain("Decline");
  });

  it("does not expose an approval affordance for a paused, unsealed step", () => {
    mock.rows = [{
      ...proposed,
      _id: "errand-paused",
      status: "needs_step_approval" as const,
      escalation: "That URL is outside the approved host list.",
    }];

    const markup = renderToStaticMarkup(<BrowserErrandApprovals owner />);

    expect(markup).toContain("browser errand paused safely");
    expect(markup).toContain("That URL is outside the approved host list.");
    expect(markup).toContain("Close paused errand");
    expect(markup).not.toContain("Approve exact plan");
  });

  it("does not query or render errands for a non-owner surface", () => {
    const markup = renderToStaticMarkup(<BrowserErrandApprovals owner={false} />);

    expect(markup).toBe("");
    expect(mock.calls).toContainEqual({ name: "browserErrands:pending", args: "skip" });
    expect(mock.calls).toContainEqual({ name: "browserErrands:unknownOutcomes", args: "skip" });
  });
});
