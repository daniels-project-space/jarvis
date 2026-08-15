import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({ controlActor: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));

import { GET } from "./route";

function request() {
  return new Request("https://jarvis.test/api/hub-context/status") as unknown as NextRequest;
}

describe("Project Hub context status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns separate dedicated context and action capability readiness to the owner", async () => {
    vi.stubEnv("JARVIS_HUB_CONTEXT_TOKEN", "dedicated-jarvis-context-token");
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "dedicated-jarvis-actions-token");

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, configured: true, actionsConfigured: true });
  });

  it("reports each missing scoped capability without falling back to the broad vault credential", async () => {
    vi.stubEnv("JARVIS_HUB_CONTEXT_TOKEN", "");
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "");
    vi.stubEnv("VAULT_ACCESS_TOKEN", "broad-vault-token-must-not-be-used");

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, configured: false, actionsConfigured: false });
  });

  it("never infers action access from an independent context capability", async () => {
    vi.stubEnv("JARVIS_HUB_CONTEXT_TOKEN", "dedicated-jarvis-context-token");
    vi.stubEnv("JARVIS_HUB_ACTIONS_TOKEN", "");
    vi.stubEnv("VAULT_ACCESS_TOKEN", "broad-vault-token-must-not-be-used");

    const response = await GET(request());

    expect(await response.json()).toEqual({ ok: true, configured: true, actionsConfigured: false });
  });

  it("refuses unauthenticated and guest status reads", async () => {
    mock.controlActor.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await GET(request())).status).toBe(403);
  });
});
