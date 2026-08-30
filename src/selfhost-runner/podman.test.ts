import { describe, expect, it, vi } from "vitest";
import type { RunnerLimits } from "./runner";
import { PodmanSelfHostedRunnerBackend, type RunnerProcess, type RunnerProcessOptions } from "./podman";

const LIMITS: RunnerLimits = {
  ttlMs: 55 * 60_000,
  commandTimeoutMs: 15 * 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxArchiveBytes: 25 * 1024 * 1024,
  cpu: 2,
  memoryMb: 4_096,
};

class FakeProcess implements RunnerProcess {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: RunnerProcessOptions }> = [];
  readonly run = vi.fn(async (executable: string, args: readonly string[], options: RunnerProcessOptions) => {
    this.calls.push({ executable, args, options });
    return {
      exitCode: 0,
      stdout: new TextEncoder().encode("a".repeat(64) + "\n"),
      stderr: new Uint8Array(),
      durationMs: 4,
    };
  });
}

describe("rootless Podman self-host runner", () => {
  it("constructs a digest-pinned, no-network, bounded, capability-free workspace", async () => {
    const process = new FakeProcess();
    const backend = new PodmanSelfHostedRunnerBackend({
      executable: "podman",
      image: `ghcr.io/example/jarvis-runner@sha256:${"b".repeat(64)}`,
      workspaceTmpfsMb: 1_024,
      user: "65532:65532",
    }, process);
    await expect(backend.create("ws-safe", LIMITS)).resolves.toEqual({ containerId: "a".repeat(64) });
    const call = process.calls[0];
    expect(call.executable).toBe("podman");
    expect(call.args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--cpus", "2",
      "--memory", "4096m",
      "--pids-limit", "512",
      "--cap-drop", "all",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--user", "65532:65532",
      "--mount", "type=tmpfs,destination=/workspace,tmpfs-size=1073741824,tmpfs-mode=1777",
      "--mount", "type=tmpfs,destination=/tmp,tmpfs-size=268435456,tmpfs-mode=1777",
    ]));
    expect(call.args.join(" ")).not.toMatch(/(?:TOKEN|SECRET|VAULT|CONVEX|TRIGGER|GITHUB|CODEX_HOME)/);
    expect(call.args.at(-3)).toContain("@sha256:");
  });

  it("rejects mutable images and non-Podman runtimes before execution", () => {
    expect(() => new PodmanSelfHostedRunnerBackend({
      executable: "podman", image: "node:22", workspaceTmpfsMb: 1_024, user: "65532:65532",
    })).toThrow(/pinned/);
    expect(() => new PodmanSelfHostedRunnerBackend({
      executable: "docker", image: `node@sha256:${"b".repeat(64)}`, workspaceTmpfsMb: 1_024, user: "65532:65532",
    })).toThrow(/rootless Podman/);
  });

  it("installs a pre-start lease and proves remote process-group cancellation", async () => {
    const calls: Array<{ args: readonly string[]; options: RunnerProcessOptions }> = [];
    const process: RunnerProcess = {
      run: async (_executable, args, options) => {
        calls.push({ args, options });
        if (args.includes("runner-exec")) {
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("adapter cancelled")), { once: true });
          });
        }
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), durationMs: 1 };
      },
    };
    const backend = new PodmanSelfHostedRunnerBackend({
      executable: "podman",
      image: `sha256:${"b".repeat(64)}`,
      workspaceTmpfsMb: 1_024,
      user: "65532:65532",
    }, process);
    const abort = new AbortController();
    const pending = backend.exec({
      version: 1,
      workspaceId: "ws-safe",
      sessionId: "session-safe",
      attemptKeyHash: "c".repeat(64),
      sourcePolicyDigest: "e".repeat(64),
      policyDigest: "d".repeat(64),
      containerId: "a".repeat(64),
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      limits: LIMITS,
    }, { command: "sleep 60", timeoutMs: 10_000, maxOutputBytes: 4_000, signal: abort.signal });
    await vi.waitFor(() => expect(calls.some((call) => call.args.includes("runner-exec"))).toBe(true));
    abort.abort();
    await expect(pending).rejects.toThrow("adapter cancelled");
    const lease = calls.find((call) => call.args.includes("runner-lease"));
    const kill = calls.find((call) => call.args.includes("runner-kill"));
    expect(lease).toBeDefined();
    expect(kill).toBeDefined();
    expect(kill?.args.some((value) => value.endsWith(".lease"))).toBe(true);
    expect(kill?.args.some((value) => value.endsWith(".started"))).toBe(true);
    expect(kill?.args.some((value) => value.endsWith(".pid"))).toBe(true);
  });
});
