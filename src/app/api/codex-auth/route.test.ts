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
vi.mock("@/lib/control-session", () => ({
  isSameOriginRequest: mock.sameOrigin,
}));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));

import { CODEX_AUTH_ENROLLMENT_CONFIRMATION } from "@/lib/codex-auth-control";
import { GET, POST } from "./route";

const owner = { kind: "owner", authTokenHash: "owner-scope" };

function request(
  method: "GET" | "POST",
  options: { body?: unknown; cookie?: string } = {},
) {
  const headers = new Headers({ origin: "https://jarvis.test" });
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new NextRequest("https://jarvis.test/api/codex-auth", {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function start() {
  mock.trigger.mockResolvedValueOnce({ id: "private-enrollment-run" });
  const response = await POST(
    request("POST", { body: { confirm: CODEX_AUTH_ENROLLMENT_CONFIRMATION } }),
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("enrollment ticket missing");
  return { response, cookie };
}

describe("owner ChatGPT reconnect control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.sameOrigin.mockReturnValue(true);
    mock.controlActor.mockResolvedValue(owner);
  });

  it("starts only the fixed no-payload enrollment task behind an HttpOnly ticket", async () => {
    const { response } = await start();
    expect(response.status).toBe(202);
    expect(mock.trigger).toHaveBeenCalledWith(
      "jarvis-codex-auth-enrollment",
      undefined,
    );
    expect(await response.json()).toEqual({ ok: true, state: "queued" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("private-enrollment-run");
  });

  it("requires the owner session, same origin, and exact confirmation", async () => {
    mock.sameOrigin.mockReturnValueOnce(false);
    expect(
      (
        await POST(
          request("POST", {
            body: { confirm: CODEX_AUTH_ENROLLMENT_CONFIRMATION },
          }),
        )
      ).status,
    ).toBe(403);
    mock.controlActor.mockResolvedValueOnce({
      kind: "guest",
      authTokenHash: "guest",
    });
    expect(
      (
        await POST(
          request("POST", {
            body: { confirm: CODEX_AUTH_ENROLLMENT_CONFIRMATION },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(request("POST", { body: { confirm: "anything else" } })))
        .status,
    ).toBe(400);
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("returns only the verified OpenAI URL and finite one-time code while waiting", async () => {
    const { cookie } = await start();
    mock.retrieve.mockResolvedValueOnce({
      status: "EXECUTING",
      metadata: {
        authEnrollment: {
          status: "waiting",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "AB12-CDE34",
          expiresAt: Date.now() + 10 * 60_000,
          credential: "must-not-leak",
        },
      },
    });
    const body = await (await GET(request("GET", { cookie }))).json();
    expect(body).toEqual({
      ok: true,
      state: "waiting",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "AB12-CDE34",
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("fails closed on an alternate URL or malformed metadata", async () => {
    const { cookie } = await start();
    mock.retrieve.mockResolvedValueOnce({
      status: "EXECUTING",
      metadata: {
        authEnrollment: {
          status: "waiting",
          verificationUri: "https://example.test",
          userCode: "AB12-CDE34",
          expiresAt: Date.now() + 60_000,
        },
      },
    });
    expect(await (await GET(request("GET", { cookie }))).json()).toEqual({
      ok: true,
      state: "starting",
    });
  });

  it("reports completion without returning the enrolled credentials or run output", async () => {
    const { cookie } = await start();
    mock.retrieve.mockResolvedValueOnce({
      status: "COMPLETED",
      output: {
        status: "connected",
        tokenExpiresAt: Date.now() + 60_000,
        authJson: "must-not-leak",
      },
    });
    const body = await (await GET(request("GET", { cookie }))).json();
    expect(body).toEqual({ ok: true, state: "connected" });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });
});
