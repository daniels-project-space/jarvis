import { afterEach, describe, expect, it, vi } from "vitest";
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
});
