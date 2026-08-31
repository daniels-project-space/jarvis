import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  controlActor: vi.fn(),
  readHubSnapshot: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/foreground-context", () => ({ readHubSnapshot: mock.readHubSnapshot }));

import { GET } from "./route";

function request(query = "shopify") {
  return new NextRequest(`https://jarvis.test/api/hub-search?q=${encodeURIComponent(query)}`);
}

describe("Project Hub quick search API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.readHubSnapshot.mockResolvedValue({
      todos: [{ _id: "one", text: "Improve Shopify margin", tags: ["snuffelo"] }],
      events: [{ _id: "two", title: "Unrelated calendar event" }],
    });
  });

  it("returns only bounded matching display metadata to the owner", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      results: [expect.objectContaining({ id: "hub:todo:one", title: "Improve Shopify margin", target: "todo" })],
    });
    expect(mock.readHubSnapshot).toHaveBeenCalledOnce();
  });

  it("fails closed before reading Hub for cross-origin, unauthenticated, guest, and short searches", async () => {
    mock.sameOrigin.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(403);

    mock.controlActor.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await GET(request())).status).toBe(403);

    expect((await GET(request("x"))).status).toBe(200);
    expect(mock.readHubSnapshot).not.toHaveBeenCalled();
  });
});
