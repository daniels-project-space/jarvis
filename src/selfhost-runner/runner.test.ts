import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerLimits, RunnerWorkspace, SelfHostedRunnerBackend } from "./runner";
import { SELF_HOSTED_RUNNER_SERVER_PROTOCOL, SELF_HOSTED_RUNNER_WORKSPACE_ROOT, SelfHostedRunnerService } from "./runner";
import { SELF_HOSTED_RUNNER_PROTOCOL_VERSION } from "../trigger/cloud-workspace-providers";
import { SelfHostedRunnerCloudWorkspaceProvider } from "../trigger/cloud-workspace-providers";

const TOKEN = "self_host_runner_test_bearer_token_0123456789";
const LIMITS: RunnerLimits = {
  ttlMs: 55 * 60_000,
  commandTimeoutMs: 15 * 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxArchiveBytes: 25 * 1024 * 1024,
  cpu: 2,
  memoryMb: 4_096,
};

class FakeBackend implements SelfHostedRunnerBackend {
  readonly create = vi.fn(async () => ({ containerId: "a".repeat(64) }));
  readonly isRunning = vi.fn(async () => true);
  readonly exec = vi.fn(async (_workspace: RunnerWorkspace, request: { command: string }) => ({
    exitCode: 0, stdout: request.command === "printf ready" ? "ready" : "", stderr: "", durationMs: 7,
  }));
  readonly readFile = vi.fn(async () => new TextEncoder().encode("hello\n"));
  readonly writeFile = vi.fn(async () => undefined);
  readonly listFiles = vi.fn(async () => ["README.md"]);
  readonly remove = vi.fn(async () => undefined);
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://runner.invalid${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-jarvis-self-hosted-runner-protocol": SELF_HOSTED_RUNNER_SERVER_PROTOCOL,
      ...init.headers,
    },
  });
}

describe("self-hosted runner host protocol", () => {
  let stateDir: string;
  let backend: FakeBackend;
  let service: SelfHostedRunnerService;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "jarvis-selfhost-runner-test-"));
    backend = new FakeBackend();
    service = new SelfHostedRunnerService({
      token: TOKEN,
      stateDir,
      image: `registry.example/jarvis-runner@sha256:${"b".repeat(64)}`,
      template: "jarvis-node22-codex-0.144.5",
      runtime: "node-22:codex-0.144.5",
      limits: LIMITS,
      maxActiveWorkspaces: 1,
    }, backend);
    await service.initialize();
  });

  afterEach(async () => {
    await service.shutdown();
    await rm(stateDir, { recursive: true, force: true });
  });

  it("keeps the host and Trigger protocol versions in lockstep", () => {
    expect(SELF_HOSTED_RUNNER_SERVER_PROTOCOL).toBe(SELF_HOSTED_RUNNER_PROTOCOL_VERSION);
  });

  it("authenticates before any workspace action and rejects policy drift", async () => {
    const unauthorized = await service.handle(new Request("http://runner.invalid/v1/workspaces", { method: "POST", body: "{}" }));
    expect(unauthorized.status).toBe(401);
    expect(backend.create).not.toHaveBeenCalled();

    const rejected = await service.handle(request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptKey: "job-1:1",
        template: "substituted-template",
        runtime: "node-22:codex-0.144.5",
        lockfileDigest: "c".repeat(64),
        limits: LIMITS,
      }),
    }));
    expect(rejected.status).toBe(409);
    expect(backend.create).not.toHaveBeenCalled();
  });

  it("creates one exact workspace, reconciles the attempt, and binds every operation to its session", async () => {
    const body = JSON.stringify({
      attemptKey: "job-1:1",
      template: "jarvis-node22-codex-0.144.5",
      runtime: "node-22:codex-0.144.5",
      lockfileDigest: "c".repeat(64),
      limits: LIMITS,
    });
    const first = await service.handle(request("/v1/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(first.status).toBe(201);
    const created = await first.json() as { workspaceId: string; sessionId: string; root: string; createdAt: number };
    expect(created.root).toBe(SELF_HOSTED_RUNNER_WORKSPACE_ROOT);
    const replay = await service.handle(request("/v1/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body }));
    await expect(replay.json()).resolves.toEqual(created);
    expect(backend.create).toHaveBeenCalledTimes(1);

    const wrong = await service.handle(request(`/v1/workspaces/${created.workspaceId}/attestation`, {
      headers: { "x-jarvis-workspace-session": "session-substituted" },
    }));
    expect(wrong.status).toBe(409);
    expect(backend.exec).not.toHaveBeenCalled();

    const executed = await service.handle(request(`/v1/workspaces/${created.workspaceId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: created.sessionId,
        command: "printf ready",
        cwd: SELF_HOSTED_RUNNER_WORKSPACE_ROOT,
        timeoutMs: 10_000,
        maxOutputBytes: 4_000,
      }),
    }));
    await expect(executed.json()).resolves.toMatchObject({ exitCode: 0, stdout: "ready", sessionId: created.sessionId });

    const removed = await service.handle(request(`/v1/workspaces/${created.workspaceId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, reason: "terminal" }),
    }));
    expect(removed.status).toBe(204);
    const retried = await service.handle(request(`/v1/workspaces/${created.workspaceId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: created.sessionId, reason: "terminal" }),
    }));
    expect(retried.status).toBe(204);
    expect(backend.remove).toHaveBeenCalledTimes(1);
  });

  it("accepts per-repository lockfile identities while fencing an attempt to its original source policy", async () => {
    const create = (attemptKey: string, lockfileDigest: string) => service.handle(request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptKey,
        template: "jarvis-node22-codex-0.144.5",
        runtime: "node-22:codex-0.144.5",
        lockfileDigest,
        limits: LIMITS,
      }),
    }));
    const first = await create("multi-repo:1", "a".repeat(64));
    expect(first.status).toBe(201);
    const workspace = await first.json() as { workspaceId: string; sessionId: string };
    expect((await create("multi-repo:1", "b".repeat(64))).status).toBe(409);
    await service.handle(request(`/v1/workspaces/${workspace.workspaceId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: workspace.sessionId, reason: "terminal" }),
    }));
    expect((await create("another-repo:1", "b".repeat(64))).status).toBe(201);
  });

  it("rejects traversal and over-limit file operations before touching the backend", async () => {
    const createdResponse = await service.handle(request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptKey: "job-2:1",
        template: "jarvis-node22-codex-0.144.5",
        runtime: "node-22:codex-0.144.5",
        lockfileDigest: "c".repeat(64),
        limits: LIMITS,
      }),
    }));
    const created = await createdResponse.json() as { workspaceId: string; sessionId: string };
    const traversal = await service.handle(request(`/v1/workspaces/${created.workspaceId}/files`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-jarvis-workspace-session": created.sessionId,
        "x-jarvis-workspace-path": "/workspace/repository/../host",
        "x-jarvis-max-bytes": "100",
      },
      body: new Uint8Array([1]),
    }));
    expect(traversal.status).toBe(400);
    expect(backend.writeFile).not.toHaveBeenCalled();

    const oversized = await service.handle(request(`/v1/workspaces/${created.workspaceId}/files`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-jarvis-workspace-session": created.sessionId,
        "x-jarvis-workspace-path": "/workspace/repository/file",
        "x-jarvis-max-bytes": String(LIMITS.maxArchiveBytes + 1),
      },
      body: new Uint8Array([1]),
    }));
    expect(oversized.status).toBe(400);
    expect(backend.writeFile).not.toHaveBeenCalled();
  });

  it("matches the real Trigger adapter wire contract, including the dot-root listing", async () => {
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const original = new Request(input, init);
      return await service.handle(new Request(original.url, {
        method: original.method,
        headers: original.headers,
        body: ["GET", "HEAD"].includes(original.method) ? undefined : await original.arrayBuffer(),
        signal: original.signal,
      }));
    });
    const provider = new SelfHostedRunnerCloudWorkspaceProvider("https://runner.example", TOKEN, transport as typeof fetch);
    const workspace = await provider.createWorkspace({
      attemptKey: "job-wire:1",
      template: "jarvis-node22-codex-0.144.5",
      runtime: "node-22:codex-0.144.5",
      lockfileDigest: "c".repeat(64),
      limits: LIMITS,
    });
    await expect(provider.listFiles(workspace, ".", 10)).resolves.toEqual(["README.md"]);
    await expect(provider.exec(workspace, { command: "printf ready", timeoutMs: 10_000, maxOutputBytes: 4_000 }))
      .resolves.toMatchObject({ stdout: "ready", providerSessionId: workspace.providerSessionId });
    await expect(provider.observeWorkspace(workspace)).resolves.toEqual({ ttlMs: LIMITS.ttlMs, observedMemory: LIMITS.memoryMb });
    await provider.terminate(workspace, "terminal");
    expect(transport).toHaveBeenCalled();
  });

  it("serializes concurrent admissions so the one-workspace quota cannot race", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    backend.create.mockImplementationOnce(async () => {
      await gate;
      return { containerId: "a".repeat(64) };
    });
    const create = (attemptKey: string) => service.handle(request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptKey,
        template: "jarvis-node22-codex-0.144.5",
        runtime: "node-22:codex-0.144.5",
        lockfileDigest: "c".repeat(64),
        limits: LIMITS,
      }),
    }));
    const first = create("job-race:1");
    const second = create("job-race:2");
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    expect(backend.create).toHaveBeenCalledTimes(1);
  });
});
