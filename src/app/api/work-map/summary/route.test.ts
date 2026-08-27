import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  controlActor: vi.fn(),
  configured: vi.fn(),
  listHubTodos: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/hub-actions", () => ({
  hubActionsReadiness: () => ({ configured: mock.configured() }),
  listHubTodos: mock.listHubTodos,
}));

import { GET } from "./route";

function request() {
  return new Request("https://jarvis.test/api/work-map/summary") as unknown as NextRequest;
}

describe("work map summary API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.configured.mockReturnValue(true);
  });

  it("returns a private owner-only bounded display list without Hub IDs or authority", async () => {
    mock.listHubTodos.mockResolvedValue([
      { id: "one", text: "Private task", done: false },
      { id: "two", text: "Already done", done: true },
      { id: "three", text: "Another private task", done: false },
    ]);
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      openTodoCount: 2,
      todos: [{ text: "Private task" }, { text: "Another private task" }],
    });
    expect(mock.listHubTodos).toHaveBeenCalledOnce();
  });

  it("fails closed for cross-origin, non-owner, unavailable, and provider-error reads", async () => {
    mock.sameOrigin.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(403);

    mock.controlActor.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await GET(request())).status).toBe(403);

    mock.configured.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(503);

    mock.listHubTodos.mockRejectedValueOnce(new Error("private upstream detail"));
    const failed = await GET(request());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false });
  });
});
