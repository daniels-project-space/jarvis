import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  isSameOriginRequest: vi.fn(),
  queueRetrieve: vi.fn(),
  queueResume: vi.fn(),
  retrieve: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  queues: { retrieve: mock.queueRetrieve, resume: mock.queueResume },
  runs: { retrieve: mock.retrieve },
  tasks: { trigger: mock.trigger },
}));
vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.isSameOriginRequest }));
vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));

import {
  BACKGROUND_READINESS_CONFIRMATION,
  BACKGROUND_WORKERS_RESUME_CONFIRMATION,
} from "@/lib/background-readiness-contract";
import { GET, POST } from "./route";

const owner = { kind: "owner", authTokenHash: "session-only-owner-hash" };

function request(method: "GET" | "POST", options: { body?: unknown; cookie?: string } = {}) {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  return new NextRequest("https://jarvis.test/api/background-readiness", {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function ticketCookie(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("readiness ticket was not set");
  return header.split(";", 1)[0];
}

async function startTicket() {
  mock.trigger.mockResolvedValueOnce({ id: "run_private_identifier" });
  const res = await POST(request("POST", { body: { confirm: BACKGROUND_READINESS_CONFIRMATION } }));
  expect(res.status).toBe(202);
  return { res, cookie: ticketCookie(res) };
}

describe("background readiness control API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.isSameOriginRequest.mockReturnValue(true);
    mock.controlActor.mockResolvedValue(owner);
    mock.queueRetrieve.mockResolvedValue({ paused: false, queued: 0 });
    mock.queueResume.mockResolvedValue({ paused: false, queued: 0 });
  });

  it("requires same-origin owner authentication and an exact explicit confirmation before triggering", async () => {
    mock.isSameOriginRequest.mockReturnValueOnce(false);
    expect((await POST(request("POST", { body: { confirm: BACKGROUND_READINESS_CONFIRMATION } }))).status).toBe(403);

    mock.isSameOriginRequest.mockReturnValueOnce(false);
    expect((await GET(request("GET"))).status).toBe(403);

    mock.controlActor.mockResolvedValueOnce(null);
    expect((await POST(request("POST", { body: { confirm: BACKGROUND_READINESS_CONFIRMATION } }))).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest" });
    expect((await POST(request("POST", { body: { confirm: BACKGROUND_READINESS_CONFIRMATION } }))).status).toBe(403);

    expect((await POST(request("POST", { body: { confirm: true } }))).status).toBe(400);
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("keeps the finite status ticket bound to the enrolled owner session", async () => {
    const { cookie } = await startTicket();
    mock.controlActor.mockResolvedValueOnce({ kind: "owner", authTokenHash: "different-owner-session" });

    const res = await GET(request("GET", { cookie }));
    expect(await res.json()).toEqual({ ok: true, status: "idle", workers: "ready", queued: 0 });
    expect(mock.retrieve).not.toHaveBeenCalled();
  });

  it("starts one manual unscheduled task without exposing its Trigger identifier", async () => {
    const { res } = await startTicket();

    expect(mock.trigger).toHaveBeenCalledTimes(1);
    expect(mock.trigger).toHaveBeenCalledWith("jarvis-background-readiness", undefined);
    expect(await res.json()).toEqual({ ok: true, status: "queued" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).not.toContain("run_private_identifier");
  });

  it("returns only a finite redacted completed status, never task diagnostics", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockResolvedValueOnce({
      status: "COMPLETED",
      output: {
        ready: false,
        controllerSession: "repair_required",
        blocker: "sensitive_controller_diagnostic",
        codex: { binary: "not_checked", subscription: "not_checked", preflight: "not_checked" },
      },
    });

    const res = await GET(request("GET", { cookie }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "attention", workers: "ready", queued: 0 });
    expect(JSON.stringify(body)).not.toContain("sensitive_controller_diagnostic");
    expect(JSON.stringify(body)).not.toContain("run_private_identifier");
  });

  it("redacts Trigger failures and never returns a provider error body", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockRejectedValueOnce(new Error("TRIGGER_SECRET_KEY=should-not-leak"));

    const res = await GET(request("GET", { cookie }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "unavailable" });
    expect(JSON.stringify(body)).not.toContain("TRIGGER_SECRET_KEY");
  });

  it("repairs only the no-work readiness queue before starting verification", async () => {
    let readinessPaused = true;
    mock.queueRetrieve.mockImplementation(async (target: { name: string }) => ({
      paused: target.name === "jarvis-background-readiness" && readinessPaused,
      queued: 0,
    }));
    mock.queueResume.mockImplementation(async (target: { name: string }) => {
      if (target.name === "jarvis-background-readiness") readinessPaused = false;
      return { paused: false, queued: 0 };
    });

    await startTicket();

    expect(mock.queueResume).toHaveBeenCalledTimes(1);
    expect(mock.queueResume).toHaveBeenCalledWith({ type: "task", name: "jarvis-background-readiness" });
    expect(mock.queueResume.mock.invocationCallOrder[0]).toBeLessThan(mock.trigger.mock.invocationCallOrder[0]);
  });

  it("resumes exact autonomous queues only after a ready owner-bound proof", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockResolvedValueOnce({
      status: "COMPLETED",
      output: { ready: true, controllerSession: "clear", workspace: "ready" },
    });
    const paused = new Set(["jarvis-background-agents", "jarvis-chat-dispatcher"]);
    mock.queueRetrieve.mockImplementation(async (target: { name: string }) => ({
      paused: paused.has(target.name),
      queued: target.name === "jarvis-chat-dispatcher" ? 12 : 0,
    }));
    mock.queueResume.mockImplementation(async (target: { name: string }) => {
      paused.delete(target.name);
      return { paused: false, queued: target.name === "jarvis-chat-dispatcher" ? 12 : 0 };
    });

    const res = await POST(request("POST", {
      cookie,
      body: { action: "resume", confirm: BACKGROUND_WORKERS_RESUME_CONFIRMATION },
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "ready", workers: "backlogged", queued: 12 });
    expect(mock.queueResume.mock.calls).toEqual([
      [{ type: "task", name: "jarvis-chat-dispatcher" }],
      [{ type: "custom", name: "jarvis-background-agents" }],
    ]);
  });

  it("refuses to resume workers without a current successful readiness proof", async () => {
    const res = await POST(request("POST", {
      body: { action: "resume", confirm: BACKGROUND_WORKERS_RESUME_CONFIRMATION },
    }));

    expect(res.status).toBe(409);
    expect(mock.queueResume).not.toHaveBeenCalled();
  });

  it("treats a stale or unavailable workspace proof as attention and never resumes queues", async () => {
    const { cookie } = await startTicket();
    mock.retrieve.mockResolvedValueOnce({
      status: "COMPLETED",
      output: {
        ready: false,
        controllerSession: "clear",
        blocker: "cloud_workspace_unavailable",
        workspace: "unavailable",
      },
    });

    const status = await GET(request("GET", { cookie }));
    expect(await status.json()).toEqual({
      ok: true,
      status: "attention",
      workers: "ready",
      queued: 0,
    });

    const resume = await POST(request("POST", {
      cookie,
      body: { action: "resume", confirm: BACKGROUND_WORKERS_RESUME_CONFIRMATION },
    }));
    expect(resume.status).toBe(409);
    expect(mock.queueResume).not.toHaveBeenCalled();
  });
});
