import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  sameOrigin: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({ tasks: { trigger: mock.trigger } }));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));

import { CLOUD_PROVIDER_PROBE_CONFIRMATION } from "@/lib/cloud-provider-probe-control";
import { POST } from "./route";

function request(body: unknown, origin = "https://jarvis.test") {
  return new NextRequest("https://jarvis.test/api/cloud-provider-probe", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("cloud provider probe owner control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "owner-scope" });
  });

  it("requires a same-origin owner request and the exact confirmation", async () => {
    mock.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request({ confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION }))).status).toBe(403);

    mock.controlActor.mockResolvedValueOnce(null);
    expect((await POST(request({ confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION }))).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await POST(request({ confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION }))).status).toBe(403);

    expect((await POST(request({ confirm: "anything else" }))).status).toBe(400);
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("triggers only the fixed no-payload attestation task", async () => {
    mock.trigger.mockResolvedValueOnce({ id: "private-run-id" });

    const response = await POST(request({ confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION, task: "ignored" }));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ ok: true, status: "queued" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mock.trigger).toHaveBeenCalledWith("jarvis-cloud-provider-probe-bootstrap", undefined);
    expect(JSON.stringify(body)).not.toContain("private-run-id");
  });

  it("redacts Trigger errors", async () => {
    mock.trigger.mockRejectedValueOnce(new Error("TRIGGER_SECRET_KEY=must-not-leak"));

    const response = await POST(request({ confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, status: "unavailable" });
  });
});
