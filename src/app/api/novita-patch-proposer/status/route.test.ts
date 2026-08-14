import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  readiness: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/novita-patch-proposer-runtime-config.server", () => ({
  novitaPatchProposerConfigurationReadiness: mock.readiness,
}));

import { GET } from "./route";

function request() {
  return new Request("https://jarvis.test/api/novita-patch-proposer/status") as unknown as NextRequest;
}

describe("Novita patch-proposer status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.readiness.mockReturnValue({ configured: false, code: "attestation_not_configured" });
  });

  it("returns only non-secret configuration state to the owner", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      configured: false,
      code: "attestation_not_configured",
    });
  });

  it("refuses unauthenticated and guest status reads", async () => {
    mock.controlActor.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await GET(request())).status).toBe(403);
  });
});
