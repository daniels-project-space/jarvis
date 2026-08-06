import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk/v3", () => ({
  auth: { createPublicToken: vi.fn() },
}));
vi.mock("@/lib/control-session", () => ({
  controlQuery: vi.fn(),
}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "owner-scope" })),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));

import { auth } from "@trigger.dev/sdk/v3";
import { controlQuery } from "@/lib/control-session";
import { controlActor } from "@/lib/request-auth";
import { POST } from "./route";

function request(body: unknown) {
  return new Request("https://jarvis-orcin-six.vercel.app/api/work-realtime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("owner-scoped work realtime token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(controlActor).mockResolvedValue({ kind: "owner" } as never);
    vi.mocked(auth.createPublicToken).mockResolvedValue("public-run-token" as never);
  });

  it("rejects anonymous and guest callers before looking up private work", async () => {
    vi.mocked(controlActor).mockResolvedValueOnce(null);
    expect((await POST(request({ jobId: "job-1" }))).status).toBe(401);
    vi.mocked(controlActor).mockResolvedValueOnce({ kind: "guest", guestId: "guest-1" } as never);
    expect((await POST(request({ jobId: "job-1" }))).status).toBe(403);
    expect(controlQuery).not.toHaveBeenCalled();
    expect(auth.createPublicToken).not.toHaveBeenCalled();
  });

  it("returns 404 without minting a token until the worker has an exact run", async () => {
    vi.mocked(controlQuery).mockResolvedValueOnce({ jobId: "job-1", workerRunId: null } as never);
    const response = await POST(request({ jobId: "job-1" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, pending: true });
    expect(auth.createPublicToken).not.toHaveBeenCalled();
  });

  it("uses the authoritative job detail run and scopes the browser token to only that run", async () => {
    vi.mocked(controlQuery).mockResolvedValueOnce({ jobId: "job-1", workerRunId: "run-authoritative" } as never);
    const response = await POST(request({ jobId: "job-1" }));
    expect(controlQuery).toHaveBeenCalledWith("jobs:detail", {
      jobId: "job-1",
      authTokenHash: "owner-scope",
    });
    expect(auth.createPublicToken).toHaveBeenCalledWith({
      scopes: { read: { runs: ["run-authoritative"] } },
      expirationTime: "1h",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      runId: "run-authoritative",
      accessToken: "public-run-token",
    });
  });
});
