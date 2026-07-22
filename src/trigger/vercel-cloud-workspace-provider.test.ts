import { Readable } from "node:stream";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEFAULT_WORKSPACE_LIMITS } from "./cloud-workspace";

type Log = { stream: "stdout" | "stderr"; data: string };
const observed: {
  create?: Record<string, unknown>; get?: Record<string, unknown>; commands: Record<string, unknown>[];
  deletes: string[]; updates: unknown[]; kills: string[]; logsClosed: number; files: Map<string, Buffer>;
  logs: Log[]; createGate?: Promise<void>; exitCode: number; commandExit?: (input: Record<string, unknown>) => number;
  updateFailure?: unknown; listed: Array<{ status: string }>;
} = { commands: [], deletes: [], updates: [], kills: [], logsClosed: 0, files: new Map(), logs: [], exitCode: 0, listed: [] };

class FakeCommand {
  readonly cmdId = `cmd-${observed.commands.length}`;
  exitCode: number | null = null;
  constructor(private readonly input: Record<string, unknown>) {}
  async wait() { this.exitCode = this.exitCode ?? observed.commandExit?.(this.input) ?? observed.exitCode; return { exitCode: this.exitCode, durationMs: 1 }; }
  async kill(signal?: string) { observed.kills.push(`${this.cmdId}:${signal}`); this.exitCode = 137; }
  logs(_opts?: { signal?: AbortSignal }) {
    let closed = false;
    return Object.assign((async function* () { for (const log of observed.logs) { if (!closed) yield log; } })(), {
      close: () => { closed = true; observed.logsClosed += 1; },
      [Symbol.dispose]: () => { closed = true; observed.logsClosed += 1; },
    });
  }
}

class FakeSession {
  sessionId = "vercel-session-a";
  status = "running";
  networkPolicy: unknown = "deny-all";
  async runCommand(input: Record<string, unknown>) {
    observed.commands.push(input);
    await observed.createGate;
    return new FakeCommand(input);
  }
  async readFile({ path }: { path: string }) { return observed.files.has(path) ? Readable.from([observed.files.get(path)!]) : null; }
  async writeFiles(files: Array<{ path: string; content: Uint8Array }>) { for (const file of files) observed.files.set(file.path, Buffer.from(file.content)); }
  async update({ networkPolicy }: { networkPolicy?: unknown }) {
    if (observed.updateFailure === networkPolicy) throw new Error("policy transition failed");
    this.networkPolicy = networkPolicy; observed.updates.push(networkPolicy);
  }
}

class FakeSandbox {
  static current = new FakeSession();
  static async list() { return { [Symbol.asyncIterator]: async function* () { yield* observed.listed; } }; }
  static async create(input: Record<string, unknown>) { observed.create = input; return new FakeSandbox(`jarvis-${"a".repeat(40)}`); }
  static async get(input: Record<string, unknown>) { observed.get = input; return new FakeSandbox(String(input.name)); }
  readonly routes: unknown[] = [];
  readonly runtime = "node22";
  readonly vcpus = 2;
  readonly memory = 4096;
  get networkPolicy() { return FakeSandbox.current.networkPolicy; }
  constructor(readonly name: string) {}
  currentSession() { return FakeSandbox.current; }
  async delete() { observed.deletes.push(this.name); }
}

vi.mock("@vercel/sandbox", () => ({ Sandbox: FakeSandbox }));

async function providerAndWorkspace() {
  const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
  const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
  const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
  return { provider, workspace };
}

beforeEach(() => {
  observed.create = undefined; observed.get = undefined; observed.commands = []; observed.deletes = []; observed.updates = []; observed.kills = []; observed.logsClosed = 0;
  observed.files = new Map(); observed.logs = []; observed.createGate = undefined; observed.exitCode = 0; observed.commandExit = undefined;
  observed.updateFailure = undefined; observed.listed = []; FakeSandbox.current = new FakeSession();
});

describe("VercelCloudWorkspaceProvider", () => {
  it("uses explicit control-plane credentials and a private node22 deny-all session", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    expect(workspace).toMatchObject({ providerWorkspaceId: `jarvis-${"a".repeat(40)}`, providerSessionId: "vercel-session-a" });
    expect(observed.create).toMatchObject({ token: "controller-token", teamId: "team_1", projectId: "prj_1", runtime: "node22", env: {}, ports: [], networkPolicy: "deny-all", resources: { vcpus: 2 }, persistent: false });
    expect((observed.create?.timeout as number) <= 44 * 60_000).toBe(true);
    await provider.terminate(workspace);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("binds command execution to the exact Session, owns its logs, and uses empty-env detached sh", async () => {
    observed.logs = [{ stream: "stdout", data: "safe-out" }, { stream: "stderr", data: "safe-err" }];
    const { provider, workspace } = await providerAndWorkspace();
    const result = await provider.exec(workspace, { command: "printf safe", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "safe-out", stderr: "safe-err", providerSessionId: "vercel-session-a" });
    expect(observed.commands[0]).toMatchObject({ cmd: "sh", args: ["-lc", "printf safe"], cwd: workspace.root, env: {}, detached: true, timeoutMs: 1_000 });
    expect(observed.commands[0]).not.toHaveProperty("stdout");
    expect(observed.logsClosed).toBe(1);
  });

  it("fails stale before data-plane work and cleanup still deletes the exact named attempt", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    FakeSandbox.current = Object.assign(new FakeSession(), { sessionId: "replaced", status: "running" });
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.commands).toEqual([]);
    await provider.terminate(workspace);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("kills and observes the exact command on cancellation and output overflow", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const cancellation = new AbortController(); cancellation.abort();
    await expect(provider.exec(workspace, { command: "sleep 1", timeoutMs: 1_000, maxOutputBytes: 1_000, signal: cancellation.signal })).rejects.toMatchObject({ code: "cancelled" });
    observed.logs = [{ stream: "stdout", data: "x".repeat(64) }];
    await expect(provider.exec(workspace, { command: "printf x", timeoutMs: 1_000, maxOutputBytes: 8 })).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.kills.some((value) => value.endsWith(":SIGKILL"))).toBe(true);
    expect(observed.logsClosed).toBeGreaterThan(0);
  });

  it("fences filesystem access and bounds streaming reads without sandbox.fs helpers", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const file = `${workspace.root}/safe.txt`; observed.files.set(file, Buffer.from("hello"));
    // The initial fixed path fence command succeeds in this fake; the stream is
    // then read from the exact session, not sandbox.fs.
    await expect(provider.readFile(workspace, "../../escape", 10)).rejects.toMatchObject({ code: "unsafe_archive" });
    observed.files.set(file, Buffer.from("0123456789"));
    await expect(provider.readFile(workspace, "safe.txt", 4)).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("relocks deny-all and deletes the workspace before a failed hydration can reach Codex", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ packages: { "node_modules/a": { resolved: "https://evil.example/a.tgz" } } })));
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(observed.updates).toContain("deny-all");
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
  });

  it("fails closed and deletes the exact attempt when command creation times out", async () => {
    let release!: () => void;
    observed.createGate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, workspace } = await providerAndWorkspace();
    await expect(provider.exec(workspace, { command: "sleep 1", timeoutMs: 5, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "timeout" });
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(observed.kills).toContain("cmd-1:SIGKILL");
  });

  it("rejects bounded lists and symlink findings from the session-scoped lstat command", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.commandExit = (input) => String(input.args).includes("find -P") ? 42 : 0;
    await expect(provider.listFiles(workspace, ".", 1)).rejects.toMatchObject({ code: "resource_limit" });
    observed.commandExit = (input) => String(input.args).includes("find -P") ? 43 : 0;
    await expect(provider.listFiles(workspace, ".", 1)).rejects.toMatchObject({ code: "unsafe_archive" });
  });

  it("relocks and terminates on install failure before any later command boundary", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    observed.commandExit = (input) => String(input.args).includes("npm ci") ? 1 : 0;
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(observed.updates).toContain("deny-all");
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("enforces the project-scoped active-attempt controller cap before create", async () => {
    observed.listed = Array.from({ length: 8 }, () => ({ status: "running" }));
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    await expect(provider.createWorkspace({ attemptKey: "job:cap", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS })).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.create).toBeUndefined();
  });
});
