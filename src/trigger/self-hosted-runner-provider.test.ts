import { describe, expect, it, vi } from "vitest";
import { configuredCloudWorkspaceProviderName } from "../lib/cloud-provider-selection";
import { createDeterministicTar, sha256Bytes } from "./cloud-workspace";
import {
  SELF_HOSTED_RUNNER_PROTOCOL_VERSION,
  SelfHostedRunnerCloudWorkspaceProvider,
} from "./cloud-workspace-providers";

const TOKEN = "self_host_runner_test_bearer_token_0123456789";
const ROOT = "/workspace/repository";

function endpoint(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("self-hosted workspace runner adapter", () => {
  it("rejects insecure or incomplete runner authority before making a request", () => {
    expect(() => new SelfHostedRunnerCloudWorkspaceProvider("http://runner.example", TOKEN)).toThrow(expect.objectContaining({
      code: "missing_configuration", provider: "selfhost",
    }));
    expect(() => new SelfHostedRunnerCloudWorkspaceProvider("https://runner.example", "too-short")).toThrow(expect.objectContaining({
      code: "missing_configuration", provider: "selfhost",
    }));
    expect(configuredCloudWorkspaceProviderName({ JARVIS_SELF_HOST_RUNNER_URL: "https://runner.example" })).toBeNull();
    expect(configuredCloudWorkspaceProviderName({ JARVIS_SELF_HOST_RUNNER_TOKEN: TOKEN })).toBeNull();
    expect(configuredCloudWorkspaceProviderName({
      JARVIS_SELF_HOST_RUNNER_URL: "https://runner.example",
      JARVIS_SELF_HOST_RUNNER_TOKEN: TOKEN,
    })).toBe("selfhost");
  });

  it("uses the authenticated HTTPS runner protocol for archive, tool, and lifecycle operations", async () => {
    const seen: Array<{ url: URL; init: RequestInit }> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = endpoint(input);
      const options = init ?? {};
      seen.push({ url, init: options });
      const method = options.method ?? "GET";
      if (url.pathname === "/relay/v1/workspaces" && method === "POST") {
        return response({ workspaceId: "runner-workspace-1", sessionId: "runner-session-1", root: ROOT, createdAt: Date.now() });
      }
      if (url.pathname === "/relay/v1/workspaces/runner-workspace-1/exec") {
        return response({ exitCode: 0, stdout: "ok", stderr: "", sessionId: "runner-session-1", durationMs: 12 });
      }
      if (url.pathname === "/relay/v1/workspaces/runner-workspace-1/files" && method === "GET") {
        if (url.searchParams.get("path")?.endsWith("README.md")) return new Response("hello\n");
        return response({ entries: ["README.md"] });
      }
      if (url.pathname === "/relay/v1/workspaces/runner-workspace-1/files" && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/relay/v1/workspaces/runner-workspace-1/attestation") {
        return response({
          protocolVersion: SELF_HOSTED_RUNNER_PROTOCOL_VERSION,
          workspaceId: "runner-workspace-1",
          sessionId: "runner-session-1",
          state: "running",
          limits: { cpu: 2, memoryMb: 4_096, ttlMs: 55 * 60_000 },
          quota: { maxActiveWorkspaces: 1, activeWorkspaces: 1 },
          security: {
            credentiallessArchive: true,
            privateIngress: true,
            networkDenyByDefault: true,
            emptyEnvironment: true,
            boundedResources: true,
            boundedTtl: true,
            exactCommandCancellation: true,
            portableCheckpointReplay: true,
          },
        });
      }
      if (url.pathname === "/relay/v1/workspaces/runner-workspace-1" && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return response({ error: "unexpected" }, 404);
    });
    const provider = new SelfHostedRunnerCloudWorkspaceProvider("https://runner.example/relay", TOKEN, request as typeof fetch);
    const workspace = await provider.createWorkspace({
      attemptKey: "job-1:1",
      template: "node22-codex-0.144.5",
      runtime: "node-22:codex-0.144.5",
      lockfileDigest: "a".repeat(64),
      limits: {
        ttlMs: 55 * 60_000,
        commandTimeoutMs: 15 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        maxFileBytes: 5 * 1024 * 1024,
        maxArchiveBytes: 25 * 1024 * 1024,
        cpu: 2,
        memoryMb: 4_096,
      },
    });
    const bytes = createDeterministicTar([{ path: "README.md", data: new TextEncoder().encode("hello\n") }]);
    await provider.uploadCredentiallessArchive(workspace, { baseSha: "0".repeat(40), sha256: sha256Bytes(bytes), bytes });
    await expect(provider.exec(workspace, { command: "git status --short", timeoutMs: 10_000, maxOutputBytes: 4_000 })).resolves.toMatchObject({ stdout: "ok" });
    await expect(provider.readFile(workspace, "README.md", 4_000)).resolves.toEqual(new TextEncoder().encode("hello\n"));
    await expect(provider.writeFile(workspace, "notes.txt", new TextEncoder().encode("safe"), 4_000)).resolves.toBeUndefined();
    await expect(provider.listFiles(workspace, ".", 10)).resolves.toEqual(["README.md"]);
    await expect(provider.observeWorkspace(workspace)).resolves.toEqual({ ttlMs: 55 * 60_000, observedMemory: 4_096 });
    await expect(provider.terminate(workspace, "terminal")).resolves.toBeUndefined();

    expect(seen.every(({ init }) => new Headers(init.headers).get("authorization") === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.every(({ init }) => new Headers(init.headers).get("x-jarvis-self-hosted-runner-protocol") === SELF_HOSTED_RUNNER_PROTOCOL_VERSION)).toBe(true);
    expect(seen.every(({ url }) => !url.toString().includes(TOKEN))).toBe(true);
    expect(seen.some(({ url }) => url.pathname.endsWith("/files") && url.searchParams.get("path") === `${ROOT}/README.md`)).toBe(true);
    expect(seen.some(({ url, init }) => url.pathname.endsWith("/files") && init.method === "PUT" && new Headers(init.headers).get("x-jarvis-workspace-path") === `${ROOT}/notes.txt`)).toBe(true);
  });

  it("rejects a substituted session before exposing its response to Codex", async () => {
    const request = vi.fn(async () => response({
      workspaceId: "runner-workspace-1", sessionId: "runner-session-1", root: ROOT, createdAt: Date.now(),
    }));
    const provider = new SelfHostedRunnerCloudWorkspaceProvider("https://runner.example", TOKEN, request as typeof fetch);
    const workspace = await provider.createWorkspace({
      attemptKey: "job-1:1", template: "node", runtime: "node-22", lockfileDigest: "a".repeat(64),
      limits: { ttlMs: 1_000, commandTimeoutMs: 1_000, maxOutputBytes: 1_000, maxFileBytes: 1_000, maxArchiveBytes: 1_000, cpu: 1, memoryMb: 1 },
    });
    request.mockResolvedValueOnce(response({ exitCode: 0, stdout: "wrong", stderr: "", sessionId: "substituted", durationMs: 1 }));
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({
      code: "invalid_configuration", provider: "selfhost",
    });
  });
});
