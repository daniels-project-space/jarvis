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

describe("Hub to-do tool outcomes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");
  });

  it("reports a confirmed creation truthfully when its optional count read times out", async () => {
    vi.useFakeTimers();
    let notifyListRead: () => void = () => {};
    const listReadStarted = new Promise<void>((resolve) => {
      notifyListRead = resolve;
    });
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.path === "jarvisActions:createTodo") {
        return Promise.resolve(Response.json({ value: { id: "todo-1" } }));
      }
      if (body.path === "jarvisActions:listTodos") {
        notifyListRead();
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(Response.json({ value: null }));
    });
    vi.stubGlobal("fetch", fetchImpl);

    const outcome = executeTool("todo_add", { text: "Prepare the release notes" });
    await listReadStarted;
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(outcome).resolves.toBe(
      "Done — \"Prepare the release notes\" is now on the hub to-do list. I could not refresh the open count.",
    );
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")).path))
      .toEqual(["jarvisActions:createTodo", "jarvisActions:listTodos"]);
  });
});
