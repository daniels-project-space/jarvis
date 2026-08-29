import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  retrieve: vi.fn(),
  sameOrigin: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  runs: { retrieve: mock.retrieve },
  tasks: { trigger: mock.trigger },
}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));

import { CLOUD_PROVIDER_PROBE_CONFIRMATION } from "@/lib/cloud-provider-probe-control";
import { GET, POST } from "./route";

const owner = { kind: "owner", authTokenHash: "owner-scope" };

function request(method: "GET" | "POST", options: { body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers = new Headers({ origin: options.origin ?? "https://jarvis.test" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new NextRequest("https://jarvis.test/api/cloud-provider-probe", {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function ticketCookie(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("probe ticket was not set");
  return header.split(";", 1)[0];
}

async function startTicket() {
  mock.trigger.mockResolvedValueOnce({ id: "private-probe-run" });
  const res = await POST(request("POST", { body: { confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION } }));
  expect(res.status).toBe(202);
  return { res, cookie: ticketCookie(res) };
}

describe("cloud provider probe owner control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue(owner);
  });

  it("requires same-origin owner authentication and exact confirmation before triggering", async () => {
    mock.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(request("POST", { body: { confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION } }))).status).toBe(403);

    mock.controlActor.mockResolvedValueOnce(null);
    expect((await POST(request("POST", { body: { confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION } }))).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await POST(request("POST", { body: { confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION } }))).status).toBe(403);

    expect((await POST(request("POST", { body: { confirm: "anything else" } }))).status).toBe(400);
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("starts only the fixed no-payload attestation and hides its run identifier", async () => {
    const { res } = await startTicket();

    expect(mock.trigger).toHaveBeenCalledWith("jarvis-cloud-provider-probe-bootstrap", undefined);
    expect(await res.json()).toEqual({ ok: true, status: "queued" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).not.toContain("private-probe-run");
  });

  it("keeps the finite probe-status ticket bound to the enrolled owner session", async () => {
    const { cookie } = await startTicket();
    mock.controlActor.mockResolvedValueOnce({ kind: "owner", authTokenHash: "different-owner-session" });

    const res = await GET(request("GET", { cookie }));
    expect(await res.json()).toEqual({ ok: true, status: "idle" });
    expect(mock.retrieve).not.toHaveBeenCalled();
  });

  it("returns only the completed attestation status, not run output", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockResolvedValueOnce({
      status: "COMPLETED",
      output: { status: "attested", deploymentId: "private-deployment-id", providerResponse: "sensitive" },
    });

    const res = await GET(request("GET", { cookie }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "attested" });
    expect(JSON.stringify(body)).not.toContain("private-deployment-id");
    expect(JSON.stringify(body)).not.toContain("sensitive");
  });

  it("maps a non-successful run to a finite attention state", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockResolvedValueOnce({ status: "FAILED", error: { message: "a safe scoped credential for the selected provider is unavailable" } });

    const res = await GET(request("GET", { cookie }));
    expect(await res.json()).toEqual({ ok: true, status: "attention", detail: "configuration" });
  });

  it("classifies a failed task without returning its raw error", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockResolvedValueOnce({
      status: "FAILED",
      error: { message: "provider said token=must-not-leak while publishing the proof" },
    });

    const body = await (await GET(request("GET", { cookie }))).json();
    expect(body).toEqual({ ok: true, status: "attention", detail: "publication" });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("redacts Trigger retrieval and trigger failures", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockRejectedValueOnce(new Error("TRIGGER_SECRET_KEY=must-not-leak"));
    const get = await GET(request("GET", { cookie }));
    expect(get.status).toBe(503);
    expect(await get.json()).toEqual({ ok: false, status: "unavailable" });

    mock.trigger.mockRejectedValueOnce(new Error("TRIGGER_SECRET_KEY=must-not-leak"));
    const post = await POST(request("POST", { body: { confirm: CLOUD_PROVIDER_PROBE_CONFIRMATION } }));
    expect(post.status).toBe(503);
    expect(await post.json()).toEqual({ ok: false, status: "unavailable" });
  });
});
