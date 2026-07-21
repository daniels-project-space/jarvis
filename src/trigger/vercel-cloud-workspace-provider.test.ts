import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKSPACE_LIMITS } from "./cloud-workspace";

const observed: { create?: Record<string, unknown>; get?: Record<string, unknown>; command?: Record<string, unknown>; deleted: string[] } = { deleted: [] };

class FakeCommand {
  exitCode: number | null = 0;
  async wait() { return { exitCode: 0 }; }
  async kill() { this.exitCode = 137; }
}

class FakeSession {
  sessionId = "vercel-session-a";
  status = "running";
  networkPolicy: unknown = "deny-all";
  async runCommand(input: Record<string, unknown>) {
    observed.command = input;
    (input.stdout as { write?: (data: string) => void } | undefined)?.write?.("safe-out");
    (input.stderr as { write?: (data: string) => void } | undefined)?.write?.("safe-err");
    return new FakeCommand();
  }
}

class FakeSandbox {
  static async create(input: Record<string, unknown>) { observed.create = input; return new FakeSandbox("jarvis-test-name"); }
  static async get(input: Record<string, unknown>) { observed.get = input; return new FakeSandbox(String(input.name)); }
  readonly routes: unknown[] = [];
  readonly runtime = "node22";
  readonly vcpus = 2;
  readonly memory = 4096;
  networkPolicy: unknown = "deny-all";
  readonly fs = {
    exists: async () => false,
    readFile: async () => Buffer.from(""),
    writeFile: async () => undefined,
    readdir: async () => [],
    lstat: async () => ({ isSymbolicLink: () => false }),
  };
  private readonly session = new FakeSession();
  constructor(readonly name: string) {}
  currentSession() { return this.session; }
  async updateNetworkPolicy(value: unknown) { this.networkPolicy = value; this.session.networkPolicy = value; }
  async delete() { observed.deleted.push(this.name); }
}

vi.mock("@vercel/sandbox", () => ({ Sandbox: FakeSandbox }));

describe("VercelCloudWorkspaceProvider", () => {
  it("uses explicit control-plane credentials, a private node22 session, and a detached empty-env shell command", async () => {
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    const workspace = await provider.createWorkspace({
      attemptKey: "job:1", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    expect(workspace.providerWorkspaceId).toBe("jarvis-test-name");
    expect(workspace.providerSessionId).toBe("vercel-session-a");
    expect(workspace.providerWorkspaceId).not.toBe(workspace.providerSessionId);
    expect(observed.create).toMatchObject({
      token: "controller-token", teamId: "team_1", projectId: "prj_1", runtime: "node22", env: {}, ports: [],
      networkPolicy: "deny-all", resources: { vcpus: 2 }, persistent: false,
    });
    expect((observed.create?.timeout as number) <= 44 * 60_000).toBe(true);
    expect(observed.create?.env).toEqual({});
    expect(JSON.stringify(observed.create?.tags)).not.toContain("controller-token");
    const result = await provider.exec(workspace, { command: "printf safe", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "safe-out", stderr: "safe-err", providerSessionId: "vercel-session-a" });
    expect(observed.command).toMatchObject({ cmd: "sh", args: ["-lc", "printf safe"], env: {}, detached: true });
    await provider.terminate(workspace);
    expect(observed.deleted).toEqual(["jarvis-test-name"]);
  });
});
