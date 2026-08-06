import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { CodexAppServer, CodexPermissionAttestationError } from "./codex-app-server";
import { runCloudWorkspaceAgent } from "./cloud-agent-runner";
import { DEFAULT_WORKSPACE_LIMITS } from "./cloud-workspace";
import { FakeCloudWorkspaceProvider } from "./cloud-workspace-fake";

describe("cloud Codex runner attestation boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("converts permission attestation failure into the provider typed blocked state", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "job:1", template: "node", runtime: "node-22",
      lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    vi.spyOn(CodexAppServer.prototype, "runTurn").mockRejectedValue(
      new CodexPermissionAttestationError("Codex thread did not activate the required permission profile"),
    );
    vi.spyOn(CodexAppServer.prototype, "stop").mockImplementation(() => undefined);

    await expect(runCloudWorkspaceAgent({
      bin: "unused", controllerScratch: "/tmp/work/controller-job-1",
      controllerEnv: { NODE_ENV: "test", CODEX_HOME: "/authority/codex-job-1", HOME: "/authority" },
      provider, workspace, prompt: "work", model: "terra", timeoutMs: 2_000,
    })).rejects.toMatchObject({
      name: "CloudWorkspaceError", code: "controller_isolation_unproven", disposition: "blocked",
    });
  });

  it("does not reach a model turn when the isolated CODEX_HOME cannot be attested", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "job:2", template: "node", runtime: "node-22",
      lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    const runTurn = vi.spyOn(CodexAppServer.prototype, "runTurn");
    await expect(runCloudWorkspaceAgent({
      bin: "unused", controllerScratch: "/tmp/work/controller-job-2",
      controllerEnv: { NODE_ENV: "test" }, provider, workspace, prompt: "work", model: "terra", timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: "controller_isolation_unproven", disposition: "blocked" });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("does not reach a model turn when the exact controller scratch is nonempty", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "job:3", template: "node", runtime: "node-22",
      lockfileDigest: "c".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    const scratch = "/tmp/work/controller-job-3-nonempty";
    mkdirSync(scratch, { recursive: true });
    writeFileSync(`${scratch}/unexpected`, "not empty");
    const runTurn = vi.spyOn(CodexAppServer.prototype, "runTurn");
    try {
      await expect(runCloudWorkspaceAgent({
        bin: "unused", controllerScratch: scratch,
        controllerEnv: { NODE_ENV: "test", CODEX_HOME: "/authority/codex-job-3", HOME: "/authority" },
        provider, workspace, prompt: "work", model: "terra", timeoutMs: 2_000,
      })).rejects.toMatchObject({ code: "controller_isolation_unproven", disposition: "blocked" });
      expect(runTurn).not.toHaveBeenCalled();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("emits the durable request phases in the exact provider callback order once", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "job:4", template: "node", runtime: "node-22",
      lockfileDigest: "d".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    const scratch = "/tmp/work/controller-job-4";
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const phases: string[] = [];
    const runTurn = vi.spyOn(CodexAppServer.prototype, "runTurn").mockImplementation(async (turn) => {
      await turn.beforeTurn?.();
      turn.onTurnRequestWritten?.();
      await turn.onTurnAccepted?.();
      return { code: 0, stdout: "", stderr: "", finalText: "done", threadId: "thread-4" };
    });
    vi.spyOn(CodexAppServer.prototype, "stop").mockImplementation(() => undefined);

    const result = await runCloudWorkspaceAgent({
      bin: "unused", controllerScratch: scratch,
      controllerEnv: { NODE_ENV: "test", CODEX_HOME: "/authority/codex-job-4", HOME: "/authority" },
      provider, workspace, prompt: "work", model: "terra", reasoningEffort: "high", timeoutMs: 2_000,
      turnReceipt: {
        beforeRequest: async () => { phases.push("request_intent"); },
        requestWritten: () => { phases.push("request_written"); },
        accepted: async () => { phases.push("accepted"); },
        effect: async () => { phases.push("effect"); },
        rejected: async () => { phases.push("rejected"); },
        completed: async () => { phases.push("completed"); },
      },
    });

    expect(result.text).toBe("done");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: "high" }));
    expect(phases).toEqual(["request_intent", "request_written", "accepted", "completed"]);
  });
});
