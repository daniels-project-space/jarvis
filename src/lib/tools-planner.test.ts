import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mock = vi.hoisted(() => ({ convexMutation: vi.fn(), convexQuery: vi.fn() }));
vi.mock("./context", () => ({ convexMutation: mock.convexMutation, convexQuery: mock.convexQuery }));
vi.mock("./control-context", () => ({
  withAdminSession: async (_authTokenHash: unknown, operation: () => Promise<unknown>) => await operation(),
}));
vi.mock("./vault", () => ({ getSecret: vi.fn(), getServiceSecrets: vi.fn() }));
vi.mock("./booking-email", () => ({
  lookupGmailBookingsReadOnly: vi.fn(), scanGmailBookingConfirmations: vi.fn(),
}));
vi.mock("./icloud-calendar", () => ({
  createICloudEvent: vi.fn(), deleteICloudEvent: vi.fn(), findICloudEvents: vi.fn(), listICloudEvents: vi.fn(),
}));

import { executeTool } from "./tools";

describe("day planner tool chain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");
    mock.convexQuery.mockResolvedValue("thread-1");
    mock.convexMutation.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.path === "jarvisActions:listTodos") {
        return Response.json({ value: [{ text: "Finish the production validation", done: false, priority: 3 }] });
      }
      if (body.path === "calendar:getCalendarStrip") {
        return Response.json({ value: [{
          pickups: [{ pickupTime: "11:00", items: [{ name: "Sony FX3 kit" }] }],
          returns: [{ returnTime: "18:00", items: [{ name: "DJI RS 3 Pro" }] }],
        }] });
      }
      return Response.json({ value: null });
    }));
  });

  it("returns live facts without another model and finishes through the existing structured-list renderer", async () => {
    const planningFacts = await executeTool("plan_my_day", { date: "2026-08-09", focus: "production validation" });

    expect(planningFacts).toContain("Build the plan yourself with your current Codex subscription reasoning; do not call another model");
    expect(planningFacts).toContain("Finish the production validation");
    expect(planningFacts).toContain("pickup Sony FX3 kit 11:00");
    expect(planningFacts).toContain("call show with kind=list, ordered=true");

    await executeTool("show", {
      kind: "list", title: "Plan · 9 August", ordered: true,
      items: [{ label: "09:00–10:30 · Production validation", detail: "Run the acceptance suite", group: "focus" }],
    });

    expect(mock.convexMutation).toHaveBeenCalledWith("ui:setPanel", expect.objectContaining({ type: "list" }));
    expect(mock.convexMutation).toHaveBeenCalledWith("chatQueue:postCard", expect.objectContaining({ type: "list" }));
  });
});
