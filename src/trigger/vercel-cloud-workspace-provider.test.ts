import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createDeterministicTar, DEFAULT_WORKSPACE_LIMITS, sha256Bytes } from "./cloud-workspace";

type Log = { stream: "stdout" | "stderr"; data: string };
type CommandOutcome = { exitCode: number; logs: Log[] };
const observed: {
  create?: Record<string, unknown>; get?: Record<string, unknown>; commands: Record<string, unknown>[];
  deletes: string[]; updates: unknown[]; updateSessions: string[]; kills: string[]; waits: string[]; logConsumers: string[]; logSignals: Array<AbortSignal | undefined>; logsClosed: number; files: Map<string, Buffer>; mkdirs: string[]; reads: string[]; readSessions: string[]; writeSessions: string[];
  readSignals: AbortSignal[]; updateSignals: AbortSignal[]; readAcquireStall?: boolean; readStream?: Readable; updateStall?: (policy: unknown) => boolean;
  logs: Log[]; createGate?: Promise<void>; waitGate?: Promise<void>; releaseWaitOnKill?: () => void; logCloseGate?: Promise<void>; waitFailure?: unknown; fenceWaitFailure?: unknown; killFailure?: unknown; deleteFailure?: unknown;
  exitCode: number; commandExit?: (input: Record<string, unknown>) => number; commandExecutor?: (input: Record<string, unknown>) => CommandOutcome | undefined;
  updateFailure?: unknown; updateHook?: (policy: unknown) => void; writeHook?: () => void; runCommandHook?: (input: Record<string, unknown>, session: FakeSession) => void; getFailure?: unknown;
  listed: Array<{ name?: string; status: string }>; listedPages?: Array<Array<{ name?: string; status: string }>>; listedPageNext?: Array<string | null>; listInputs: Record<string, unknown>[];
  listGate?: Promise<void>; listPageGate?: Promise<void>; sandboxCreateGate?: Promise<void>;
} = { commands: [], deletes: [], updates: [], updateSessions: [], kills: [], waits: [], logConsumers: [], logSignals: [], logsClosed: 0, files: new Map(), mkdirs: [], reads: [], readSessions: [], writeSessions: [], readSignals: [], updateSignals: [], logs: [], exitCode: 0, listed: [], listInputs: [] };

function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return new Promise<never>(() => undefined);
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

class FakeCommand {
  readonly cmdId = `cmd-${observed.commands.length}`;
  exitCode: number | null = null;
  constructor(private readonly input: Record<string, unknown>, private readonly outcome?: CommandOutcome) {}
  async wait() {
    observed.waits.push(this.cmdId);
    await observed.waitGate;
    if (observed.fenceWaitFailure && String(this.input.args).includes("realpath")) throw observed.fenceWaitFailure;
    if (observed.waitFailure && String(this.input.args).includes("true")) throw observed.waitFailure;
    this.exitCode = this.exitCode ?? this.outcome?.exitCode ?? observed.commandExit?.(this.input) ?? observed.exitCode;
    return { exitCode: this.exitCode, durationMs: 1 };
  }
  async kill(signal?: string) { observed.kills.push(`${this.cmdId}:${signal}`); this.exitCode = 137; observed.releaseWaitOnKill?.(); if (observed.killFailure) throw observed.killFailure; }
  logs(options?: { signal?: AbortSignal }) {
    observed.logSignals.push(options?.signal);
    observed.logConsumers.push(this.cmdId);
    let closed = false;
    const logs = this.outcome?.logs ?? observed.logs;
    return Object.assign((async function* () { for (const log of logs) { if (!closed) yield log; } })(), {
      close: async () => { await observed.logCloseGate; closed = true; observed.logsClosed += 1; },
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
    if (String(input.args).includes("sleep 1")) await observed.createGate;
    const command = new FakeCommand(input, observed.commandExecutor?.(input));
    observed.runCommandHook?.(input, this);
    return command;
  }
  async mkDir(path: string) { observed.mkdirs.push(path); }
  async readFile({ path }: { path: string }, options?: { signal?: AbortSignal }) {
    observed.reads.push(path);
    observed.readSessions.push(this.sessionId);
    if (options?.signal) observed.readSignals.push(options.signal);
    if (observed.readAcquireStall) await rejectWhenAborted(options?.signal);
    if (observed.readStream) return observed.readStream;
    return observed.files.has(path) ? Readable.from([observed.files.get(path)!]) : null;
  }
  async writeFiles(files: Array<{ path: string; content: Uint8Array }>) {
    observed.writeSessions.push(this.sessionId);
    for (const file of files) observed.files.set(file.path, Buffer.from(file.content));
    observed.writeHook?.();
  }
  async update({ networkPolicy }: { networkPolicy?: unknown }, options?: { signal?: AbortSignal }) {
    if (options?.signal) observed.updateSignals.push(options.signal);
    if (observed.updateStall?.(networkPolicy)) await rejectWhenAborted(options?.signal);
    if (observed.updateFailure === networkPolicy) throw new Error("policy transition failed");
    this.networkPolicy = networkPolicy; observed.updates.push(networkPolicy); observed.updateSessions.push(this.sessionId); observed.updateHook?.(networkPolicy);
  }
}

class FakeSandbox {
  static current = new FakeSession();
  static async list(input: Record<string, unknown>) {
    observed.listInputs.push(input);
    if (input.namePrefix && (input.sortBy !== "name" || input.sortOrder !== "asc")) {
      throw new Error("namePrefix is only valid with deterministic name sorting");
    }
    await observed.listGate;
    const pages = observed.listedPages ?? [observed.listed];
    const materialized = pages.map((sandboxes, index) => ({ sandboxes, pagination: { count: sandboxes.length, next: observed.listedPageNext?.[index] ?? (index + 1 < pages.length ? `cursor-${index + 1}` : null) } }));
    return Object.assign(materialized[0]!, {
      pages: async function* () {
        for (let index = 0; index < materialized.length; index += 1) {
          if (index > 0) await observed.listPageGate;
          yield materialized[index]!;
        }
      },
      [Symbol.asyncIterator]: async function* () { for (const page of materialized) yield* page.sandboxes; },
    });
  }
  static async create(input: Record<string, unknown>) {
    observed.create = input;
    await observed.sandboxCreateGate;
    return new FakeSandbox(String(input.name ?? `jarvis-${"a".repeat(40)}`));
  }
  static async get(input: Record<string, unknown>) {
    observed.get = input;
    if (observed.getFailure) throw observed.getFailure;
    return new FakeSandbox(String(input.name));
  }
  readonly routes: unknown[] = [];
  readonly runtime = "node22";
  readonly vcpus = 2;
  readonly memory = 4096;
  get networkPolicy() { return FakeSandbox.current.networkPolicy; }
  private readonly snapshot = FakeSandbox.current;
  constructor(readonly name: string) {}
  currentSession() { return this.snapshot; }
  runCommand(input: Parameters<FakeSession["runCommand"]>[0]) { return this.snapshot.runCommand(input); }
  async delete() { observed.deletes.push(this.name); if (observed.deleteFailure) throw observed.deleteFailure; }
}

vi.mock("@vercel/sandbox", () => ({ Sandbox: FakeSandbox }));

async function providerAndWorkspace(deadlines?: { listMs: number; createMs: number; controlMs: number }) {
  const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
  const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1", deadlines);
  const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
  return { provider, workspace };
}

/** Execute only the exact generated listing program on the host's temporary
 * directory. The surrounding Session is still fake, but its listing exit code
 * and base64 log data come from the real child process, never a substring
 * based mock exit hook. */
function executeExactListingProgram(input: Record<string, unknown>): CommandOutcome | undefined {
  const args = input.args;
  const command = Array.isArray(args) ? args[1] : undefined;
  if (typeof command !== "string" || !command.startsWith("node -e ")) return undefined;
  const completed = spawnSync("sh", ["-lc", command], { encoding: "buffer" });
  const stdout = Buffer.from(completed.stdout ?? "").toString("utf8");
  const stderr = Buffer.from(completed.stderr ?? "").toString("utf8");
  return {
    exitCode: completed.status ?? 1,
    logs: [
      ...(stdout ? [{ stream: "stdout" as const, data: stdout }] : []),
      ...(stderr ? [{ stream: "stderr" as const, data: stderr }] : []),
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "team_1", billing: { plan: "hobby", status: "active" } }),
  })));
  observed.create = undefined; observed.get = undefined; observed.commands = []; observed.deletes = []; observed.updates = []; observed.updateSessions = []; observed.kills = []; observed.waits = []; observed.logConsumers = []; observed.logSignals = []; observed.logsClosed = 0;
  observed.files = new Map(); observed.mkdirs = []; observed.reads = []; observed.readSessions = []; observed.writeSessions = []; observed.logs = []; observed.createGate = undefined; observed.waitGate = undefined; observed.releaseWaitOnKill = undefined; observed.logCloseGate = undefined; observed.waitFailure = undefined; observed.fenceWaitFailure = undefined; observed.killFailure = undefined; observed.deleteFailure = undefined; observed.exitCode = 0; observed.commandExit = undefined;
  observed.readSignals = []; observed.updateSignals = []; observed.readAcquireStall = undefined; observed.readStream = undefined; observed.updateStall = undefined;
  observed.updateFailure = undefined; observed.updateHook = undefined; observed.writeHook = undefined; observed.runCommandHook = undefined; observed.commandExecutor = undefined; observed.getFailure = undefined; observed.listed = []; observed.listedPages = undefined; observed.listedPageNext = undefined; observed.listInputs = []; FakeSandbox.current = new FakeSession();
  observed.listGate = undefined; observed.listPageGate = undefined; observed.sandboxCreateGate = undefined;
});

describe("VercelCloudWorkspaceProvider", () => {
  it("requires explicit approval before a Pro team can create a sandbox", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "team_1", billing: { plan: "pro", status: "active" } }),
    } as Response);
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    await expect(provider.createWorkspace({
      attemptKey: "job:paid-plan", template: "node22", runtime: "node-22",
      lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    })).rejects.toMatchObject({ code: "invalid_configuration", disposition: "blocked" });
    expect(observed.listInputs).toEqual([]);
    expect(observed.create).toBeUndefined();

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "team_1", billing: { plan: "pro", status: "active" } }),
    } as Response);
    const approvedProvider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1", undefined, true);
    await expect(approvedProvider.createWorkspace({
      attemptKey: "job:approved-paid-plan", template: "node22", runtime: "node-22",
      lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    })).resolves.toMatchObject({ provider: "vercel" });
    expect(observed.create).toBeDefined();

    observed.listInputs = [];
    observed.create = undefined;
    vi.mocked(fetch).mockRejectedValueOnce(new Error("billing endpoint unavailable"));
    await expect(provider.createWorkspace({
      attemptKey: "job:unknown-plan", template: "node22", runtime: "node-22",
      lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    })).rejects.toMatchObject({ code: "provider_unavailable", disposition: "deferred" });
    expect(observed.listInputs).toEqual([]);
    expect(observed.create).toBeUndefined();
  });

  it("uses explicit control-plane credentials and a private node22 deny-all session", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    expect(workspace).toMatchObject({
      providerWorkspaceId: `jarvis-${createHash("sha256").update("job:1").digest("hex").slice(0, 40)}`,
      providerSessionId: "vercel-session-a",
    });
    expect(observed.create).toMatchObject({ token: "controller-token", teamId: "team_1", projectId: "prj_1", runtime: "node22", env: {}, ports: [], networkPolicy: "deny-all", resources: { vcpus: 2 }, persistent: false });
    expect((observed.create?.timeout as number) <= 44 * 60_000).toBe(true);
    await provider.terminate(workspace);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("binds command execution to the exact Session, owns its logs, and uses empty-env detached sh", async () => {
    observed.logs = [{ stream: "stdout", data: "safe-out" }, { stream: "stderr", data: "safe-err" }];
    const { provider, workspace } = await providerAndWorkspace();
    observed.logSignals = [];
    const result = await provider.exec(workspace, { command: "printf safe", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "safe-out", stderr: "safe-err", providerSessionId: "vercel-session-a" });
    expect(observed.get).toMatchObject({ name: workspace.providerWorkspaceId, resume: false, token: "controller-token", teamId: "team_1", projectId: "prj_1" });
    const command = observed.commands.find((candidate) => String(candidate.args).includes("printf safe"));
    expect(command).toMatchObject({ cmd: "sh", args: ["-lc", "printf safe"], cwd: workspace.root, env: {}, detached: true, timeoutMs: 1_000 });
    expect(command).not.toHaveProperty("stdout");
    expect(observed.logsClosed).toBe(2);
    expect(observed.waits).toHaveLength(2);
    expect(observed.logConsumers).toHaveLength(2);
    expect(observed.logSignals).toEqual([undefined, undefined]);
  });

  it("fails stale before data-plane work and cleanup still deletes the exact named attempt", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    FakeSandbox.current = Object.assign(new FakeSession(), { sessionId: "replaced", status: "running" });
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.commands).toEqual([]);
    await provider.terminate(workspace);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("treats a stopped exact session as stale before a filesystem read", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    FakeSandbox.current.status = "stopped";
    await expect(provider.readFile(workspace, "safe.txt", 10)).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.reads).toEqual([]);
  });

  it("treats a missing named session as stale without a data-plane call", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.getFailure = new Error("404 not found");
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.commands).toEqual([]);
    await expect(provider.terminate(workspace)).resolves.toBeUndefined();
  });

  it("re-fetches without resume after a session data-plane write and rejects a replacement", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.writeHook = () => {
      FakeSandbox.current = Object.assign(new FakeSession(), { sessionId: "replaced-after-write" });
    };
    await expect(provider.writeFile(workspace, "safe.txt", new TextEncoder().encode("safe"), 10)).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.files.get(`${workspace.root}/safe.txt`)?.toString()).toBe("safe");
    expect(observed.get).toMatchObject({ name: workspace.providerWorkspaceId, resume: false });
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("treats every command creation as a substitution boundary before logs or a later command", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.runCommandHook = (input) => {
      if (String(input.args).includes("realpath")) {
        FakeSandbox.current = Object.assign(new FakeSession(), { sessionId: "replaced-after-cwd-fence" });
      }
    };
    await expect(provider.exec(workspace, { command: "echo requested", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.commands).toHaveLength(1);
    expect(observed.commands.some((command) => String(command.args).includes("echo requested"))).toBe(false);
    expect(observed.waits).toHaveLength(1);
    expect(observed.logConsumers).toHaveLength(0);
    expect(observed.kills).toHaveLength(1);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("kills, waits, and exact-deletes once when the requested command is replaced", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.runCommandHook = (input) => {
      if (String(input.args).includes("echo requested")) {
        FakeSandbox.current = Object.assign(new FakeSession(), { sessionId: "replaced-after-request" });
      }
    };
    await expect(provider.exec(workspace, { command: "echo requested", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "stale_attempt" });
    // The cwd fence completes normally; the requested command is never given
    // a log consumer once its post-create identity observation fails.
    expect(observed.commands).toHaveLength(2);
    expect(observed.waits).toHaveLength(2);
    expect(observed.logConsumers).toHaveLength(1);
    expect(observed.kills).toHaveLength(1);
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
    expect(observed.kills).toHaveLength(1);
    observed.logs = [];
    const activeCancellation = new AbortController();
    await expect(provider.exec(workspace, { command: "printf signal", timeoutMs: 1_000, maxOutputBytes: 1_000, signal: activeCancellation.signal })).resolves.toMatchObject({ exitCode: 0 });
    const requested = observed.commands.find((command) => String(command.args).includes("printf signal"));
    expect(requested?.signal).toBe(activeCancellation.signal);
  });

  it("applies one cumulative byte budget across stdout and stderr", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.logs = [{ stream: "stdout", data: "12345" }, { stream: "stderr", data: "67890" }];
    await expect(provider.exec(workspace, { command: "printf mixed", timeoutMs: 1_000, maxOutputBytes: 8 })).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.kills.some((value) => value.endsWith(":SIGKILL"))).toBe(true);
    expect(observed.logsClosed).toBe(2);
    expect(observed.kills).toHaveLength(1);
  });

  it("fences filesystem access and bounds streaming reads without sandbox.fs helpers", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const file = `${workspace.root}/safe.txt`; observed.files.set(file, Buffer.from("hello"));
    // The initial fixed path fence command succeeds in this fake; the stream is
    // then read from the exact session, not sandbox.fs.
    await expect(provider.readFile(workspace, "../../escape", 10)).rejects.toMatchObject({ code: "unsafe_archive" });
    observed.files.set(file, Buffer.from("0123456789"));
    await expect(provider.readFile(workspace, "safe.txt", 4)).rejects.toMatchObject({ code: "resource_limit" });
    observed.commandExit = (input) => String(input.args).includes("realpath") ? 1 : 0;
    await expect(provider.readFile(workspace, "safe.txt", 10)).rejects.toMatchObject({ code: "unsafe_archive" });
  });

  it("aborts stalled file-stream acquisition and exact-cleans dependency hydration", async () => {
    const { provider, workspace } = await providerAndWorkspace({ listMs: 50, createMs: 50, controlMs: 5 });
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    observed.readAcquireStall = true;

    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({
      code: "timeout",
      disposition: "deferred",
    });
    expect(observed.readSignals).toHaveLength(1);
    expect(observed.readSignals[0]?.aborted).toBe(true);
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("aborts and destroys a stalled file-stream iteration before exact cleanup", async () => {
    const { provider, workspace } = await providerAndWorkspace({ listMs: 50, createMs: 50, controlMs: 5 });
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    let emitted = false;
    const stream = new Readable({
      read() {
        if (!emitted) {
          emitted = true;
          this.push(Buffer.from('{"lockfileVersion":3'));
        }
      },
    });
    observed.readStream = stream;

    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({
      code: "timeout",
      disposition: "deferred",
    });
    expect(observed.readSignals).toHaveLength(1);
    expect(observed.readSignals[0]?.aborted).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("creates only the fenced repository root through the exact Session before controller writes", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const bytes = createDeterministicTar([{ path: "package.json", data: new TextEncoder().encode("{}") }]);
    await provider.uploadCredentiallessArchive(workspace, { baseSha: "0".repeat(40), sha256: sha256Bytes(bytes), bytes });
    expect(observed.mkdirs).toEqual([workspace.root]);
    expect(observed.files.has(`${workspace.root}/.jarvis-controller-${workspace.providerWorkspaceId}/source-upload.tar`)).toBe(true);
  });

  it("deletes a partially hydrated attempt when upload or baseline creation fails", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const bytes = createDeterministicTar([{ path: "package.json", data: new TextEncoder().encode("{}") }]);
    observed.commandExit = (input) => String(input.args).includes("git init -q") ? 1 : 0;
    await expect(provider.uploadCredentiallessArchive(workspace, { baseSha: "0".repeat(40), sha256: sha256Bytes(bytes), bytes })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("relocks deny-all and deletes the workspace before a failed hydration can reach Codex", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ packages: { "node_modules/a": { resolved: "https://evil.example/a.tgz" } } })));
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(observed.updates).toContain("deny-all");
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
  });

  it("accepts only the exact HTTPS npm registry authority in a committed lock", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ packages: {
      "node_modules/a": { resolved: "http://registry.npmjs.org/a.tgz" },
    } })));
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("rejects a lock that is present but no longer matches the committed controller baseline", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    observed.commandExit = (input) => String(input.args).includes("git ls-files --error-unmatch") ? 1 : 0;
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(observed.updates).toContain("deny-all");
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("treats a policy-transition session substitution as stale before npm can start", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    observed.updateHook = (policy) => {
      if (typeof policy === "object") FakeSandbox.current = Object.assign(new FakeSession(), { sessionId: "replaced-after-policy" });
    };
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "stale_attempt" });
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it.each([
    {
      label: "allow-only transition",
      stalls: (policy: unknown) => typeof policy === "object",
      npmStarted: false,
    },
    {
      label: "deny-all relock",
      stalls: (policy: unknown) => policy === "deny-all",
      npmStarted: true,
    },
  ])("aborts a stalled $label and exact-cleans before returning", async ({ stalls, npmStarted }) => {
    const { provider, workspace } = await providerAndWorkspace({ listMs: 50, createMs: 50, controlMs: 5 });
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    observed.updateStall = stalls;

    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({
      code: "timeout",
      disposition: "deferred",
    });
    expect(observed.updateSignals.length).toBeGreaterThan(0);
    expect(observed.updateSignals.some((signal) => signal.aborted)).toBe(true);
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(npmStarted);
    expect(observed.commands.some((command) => String(command.args).includes("fetch("))).toBe(false);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("fails closed and deletes the exact attempt when command creation times out", async () => {
    let release!: () => void;
    observed.createGate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, workspace } = await providerAndWorkspace();
    await expect(provider.exec(workspace, { command: "sleep 1", timeoutMs: 5, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "timeout" });
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(observed.kills).toHaveLength(1);
    expect(observed.kills[0]).toMatch(/:SIGKILL$/);
    expect(observed.waits).toHaveLength(2);
    expect(observed.logConsumers).toHaveLength(1);
  });

  it("fails closed and deletes the exact attempt when cancellation races command creation", async () => {
    let release!: () => void;
    observed.createGate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, workspace } = await providerAndWorkspace();
    const controller = new AbortController();
    const running = provider.exec(workspace, { command: "sleep 1", timeoutMs: 1_000, maxOutputBytes: 1_000, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(observed.kills).toHaveLength(1);
    expect(observed.kills[0]).toMatch(/:SIGKILL$/);
    expect(observed.waits).toHaveLength(2);
    expect(observed.logConsumers).toHaveLength(1);
  });

  it("coalesces repeated termination signals into one kill and one wait for the requested command", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    let release!: () => void;
    observed.runCommandHook = (input) => {
      if (String(input.args).includes("sleep 1")) {
        observed.waitGate = new Promise<void>((resolve) => { release = resolve; });
        observed.releaseWaitOnKill = release;
      }
    };
    const controller = new AbortController();
    const running = provider.exec(workspace, { command: "sleep 1", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(observed.kills).toHaveLength(1);
    expect(observed.waits).toHaveLength(2);
    expect(observed.logConsumers).toHaveLength(2);
  });

  it("treats Vercel's already-exited kill response as terminal after the exact wait", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    let release!: () => void;
    observed.runCommandHook = (input) => {
      if (String(input.args).includes("sleep terminal")) {
        observed.waitGate = new Promise<void>((resolve) => { release = resolve; });
        observed.releaseWaitOnKill = release;
      }
    };
    observed.killFailure = Object.assign(new Error("command exited"), {
      json: { error: { code: "command_not_found_or_exited" } },
    });
    const controller = new AbortController();
    const running = provider.exec(workspace, { command: "sleep terminal", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(observed.kills).toHaveLength(1);
    expect(observed.waits).toHaveLength(2);
  });

  it("runs the exact listing program against real byte-named directories and preserves exit classifications", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const listingExitCodes: number[] = [];
    observed.commandExecutor = (input) => {
      const outcome = executeExactListingProgram(input);
      if (outcome) listingExitCodes.push(outcome.exitCode);
      return outcome;
    };
    const roots: string[] = [];
    const makeWorkspace = () => {
      const root = mkdtempSync(join(tmpdir(), "jarvis-vercel-listing-"));
      roots.push(root);
      return { ...workspace, root };
    };
    try {
      await expect(provider.listFiles(makeWorkspace(), ".", 2)).resolves.toEqual([]);

      const one = makeWorkspace();
      writeFileSync(join(one.root, "only"), "safe");
      await expect(provider.listFiles(one, ".", 1)).resolves.toEqual(["only"]);

      const exact = makeWorkspace();
      writeFileSync(join(exact.root, "one"), "safe");
      writeFileSync(join(exact.root, "two"), "safe");
      await expect(provider.listFiles(exact, ".", 2)).resolves.toEqual(expect.arrayContaining(["one", "two"]));

      const overflow = makeWorkspace();
      writeFileSync(join(overflow.root, "one"), "safe");
      writeFileSync(join(overflow.root, "two"), "safe");
      await expect(provider.listFiles(overflow, ".", 1)).rejects.toMatchObject({ code: "resource_limit" });

      const linked = makeWorkspace();
      writeFileSync(join(linked.root, "target"), "safe");
      symlinkSync("target", join(linked.root, "link"));
      await expect(provider.listFiles(linked, ".", 2)).rejects.toMatchObject({ code: "unsafe_archive" });

      const broken = makeWorkspace();
      symlinkSync("missing-target", join(broken.root, "broken-link"));
      await expect(provider.listFiles(broken, ".", 2)).rejects.toMatchObject({ code: "unsafe_archive" });

      if (process.platform !== "win32") {
        const invalid = makeWorkspace();
        const invalidName = Buffer.concat([Buffer.from(invalid.root), Buffer.from("/"), Buffer.from([0xff])]);
        writeFileSync(invalidName, "safe");
        await expect(provider.listFiles(invalid, ".", 1)).rejects.toMatchObject({ code: "unsafe_patch" });
      }
      const listingCommands = observed.commands
        .map((command) => Array.isArray(command.args) ? command.args[1] : "")
        .filter((command): command is string => typeof command === "string" && command.startsWith("node -e "));
      expect(listingCommands).toHaveLength(process.platform === "win32" ? 6 : 7);
      expect(listingCommands.every((command) => !/find -P|wc -c|base64 -w|\|\s*(?:find|wc|base64)/.test(command))).toBe(true);
      expect(listingExitCodes).toEqual(process.platform === "win32" ? [0, 0, 0, 42, 43, 43] : [0, 0, 0, 42, 43, 43, 0]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  it("strictly decodes NUL listings and accepts exactly the requested entry limit", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.logs = [{ stream: "stdout", data: Buffer.from("only\0").toString("base64") }];
    await expect(provider.listFiles(workspace, ".", 1)).resolves.toEqual(["only"]);
    const malformed = [
      "b25seQ", // non-canonical missing padding
      Buffer.from("only").toString("base64"), // unterminated NUL frame
      Buffer.from("\0only\0").toString("base64"), // initial empty field
      Buffer.from("one\0\0two\0").toString("base64"), // repeated NUL
      "@@@@", // malformed base64 alphabet
    ];
    for (const data of malformed) {
      observed.logs = [{ stream: "stdout", data }];
      await expect(provider.listFiles(workspace, ".", 1)).rejects.toMatchObject({ code: "unsafe_archive" });
    }
    observed.logs = [{ stream: "stdout", data: Buffer.from([0xff, 0]).toString("base64") }];
    await expect(provider.listFiles(workspace, ".", 1)).rejects.toMatchObject({ code: "unsafe_patch" });
    observed.logs = [{ stream: "stdout", data: Buffer.from("one\0two\0").toString("base64") }];
    await expect(provider.listFiles(workspace, ".", 1)).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.commands.some((command) => String(command.args).includes("node -e"))).toBe(true);
  });

  it("relocks and terminates on install failure before any later command boundary", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    observed.commandExit = (input) => String(input.args).includes("npm ci") ? 1 : 0;
    await expect(provider.hydrateDependencies(workspace)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(observed.updates).toContain("deny-all");
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
  });

  it("keeps the npm cache and cleanup path inside the attempt-fenced repository", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.files.set(`${workspace.root}/package-lock.json`, Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {} })));
    await provider.hydrateDependencies(workspace);
    const install = observed.commands.find((command) => String(command.args).includes("npm ci"));
    expect(String(install?.args)).toContain(`${workspace.root}/.jarvis-controller-${workspace.providerWorkspaceId}/npm-cache`);
    expect(String(install?.args)).not.toContain("/vercel/sandbox/.jarvis-npm-cache");
    expect(String(install?.args)).toContain("git clean -ffd -e node_modules");
    expect(String(install?.args)).not.toContain("git clean -ffdX");
    expect(String(install?.args)).toContain(`-e '.jarvis-controller-${workspace.providerWorkspaceId}'`);
    expect(String(install?.args)).toContain(`-e '.jarvis-controller-${workspace.providerWorkspaceId}/'`);
    expect(String(install?.args)).toContain(`-e '.jarvis-controller-${workspace.providerWorkspaceId}/**'`);
    expect(observed.updates).toEqual([{ allow: ["registry.npmjs.org"] }, "deny-all"]);
  });

  it("keeps a lockfile-free attempt deny-all and proves egress is blocked before returning", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.commandExit = (input) => String(input.args).includes("test -f") ? 1 : 0;
    await provider.hydrateDependencies(workspace);
    expect(observed.commands.some((command) => String(command.args).includes("npm ci"))).toBe(false);
    expect(observed.updates).toEqual(["deny-all"]);
    expect(observed.commands.some((command) => String(command.args).includes("fetch("))).toBe(true);
  });

  it("rejects unbounded command and listing requests before a session data-plane call", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 45 * 60_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "resource_limit" });
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes + 1 })).rejects.toMatchObject({ code: "resource_limit" });
    await expect(provider.listFiles(workspace, ".", 10_001)).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.commands).toEqual([]);
  });

  it("enforces the project-scoped active-attempt controller cap before create", async () => {
    const { VERCEL_ACTIVE_SANDBOX_CAP, VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    observed.listed = Array.from({ length: VERCEL_ACTIVE_SANDBOX_CAP }, () => ({ status: "running" }));
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    await expect(provider.createWorkspace({ attemptKey: "job:cap", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS })).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.create).toBeUndefined();
    observed.listed = Array.from({ length: VERCEL_ACTIVE_SANDBOX_CAP }, () => ({ status: "snapshotting" }));
    await expect(provider.createWorkspace({ attemptKey: "job:snapshot-cap", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS })).rejects.toMatchObject({ code: "resource_limit" });
    expect(observed.create).toBeUndefined();
  });

  it("fails closed when a history paginator ends while its last page advertises another cursor", async () => {
    observed.listedPages = [[{ status: "stopped" }]];
    observed.listedPageNext = ["cursor-that-was-not-observed"];
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    await expect(provider.createWorkspace({ attemptKey: "job:incomplete-history", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(observed.create).toBeUndefined();
  });

  it("uses the archive limit only for controller artifacts and round-trips a source archive above the public file cap", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const source = createDeterministicTar(Array.from({ length: 6 }, (_, index) => ({ path: `src/${index}.txt`, data: new Uint8Array(1024 * 1024).fill(index) })));
    expect(source.byteLength).toBeGreaterThan(DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
    const control = `${workspace.root}/.jarvis-controller-${workspace.providerWorkspaceId}`;
    observed.files.set(`${control}/source.tar`, Buffer.from(source));
    observed.files.set(`${control}/checkpoint.patch`, Buffer.alloc(0));
    await expect(provider.readFile(workspace, "safe.txt", source.byteLength)).rejects.toMatchObject({ code: "resource_limit" });
    const checkpoint = await provider.checkpoint(workspace, {
      jobId: "job", attempt: 1, baseSha: "0".repeat(40), sourceArchiveSha256: sha256Bytes(source), sourceArchiveBytes: source.byteLength,
      runtime: "node-22", lockfileDigest: "a".repeat(64), template: "node22", attemptKey: "job:1", causationId: "cause",
    });
    expect(checkpoint.archive.byteLength).toBeGreaterThan(DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
    const recreated = await provider.recreateFromCheckpoint({ checkpoint: checkpoint.manifest, archive: checkpoint.archive, limits: DEFAULT_WORKSPACE_LIMITS, attemptKey: "job:2" });
    expect(observed.files.get(`${recreated.root}/.jarvis-controller-${recreated.providerWorkspaceId}/replay.tar`)?.byteLength).toBe(checkpoint.archive.byteLength);
    observed.files.set(`${control}/output.patch`, Buffer.alloc(0));
    await expect(provider.exportPatch(workspace, "0".repeat(40), DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes)).resolves.toMatchObject({ byteCount: 0 });
  });

  it("realpath-fences a symlink cwd before the requested command is created", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.commandExit = (input) => String(input.args).includes("realpath") ? 1 : 0;
    await expect(provider.exec(workspace, { command: "echo should-not-run", cwd: `${workspace.root}/linked`, timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(observed.commands.some((input) => String(input.args).includes("echo should-not-run"))).toBe(false);
  });

  it("owns, kills, and cleans up a failed cwd-fence wait before creating the requested command", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.fenceWaitFailure = new Error("cwd fence wait failed");
    await expect(provider.exec(workspace, { command: "echo should-not-run", cwd: workspace.root, timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toThrow("cwd fence wait failed");
    expect(observed.kills).toHaveLength(1);
    expect(observed.kills[0]).toMatch(/:SIGKILL$/);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);
    expect(observed.commands.some((input) => String(input.args).includes("echo should-not-run"))).toBe(false);
    expect(observed.logsClosed).toBe(1);
  });

  it("owns one terminal wait and one kill/observe chain when wait or iterator close is delayed", async () => {
    let releaseWait!: () => void;
    observed.waitGate = new Promise<void>((resolve) => { releaseWait = resolve; });
    const { provider, workspace } = await providerAndWorkspace();
    const running = provider.exec(workspace, { command: "sleep 1", timeoutMs: 1_000, maxOutputBytes: 1_000 });
    await new Promise((resolve) => setImmediate(resolve));
    releaseWait();
    await expect(running).resolves.toMatchObject({ exitCode: 0 });
    expect(observed.kills).toEqual([]);
    let releaseClose!: () => void;
    observed.logCloseGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closing = provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: 1_000 });
    await new Promise((resolve) => setImmediate(resolve));
    releaseClose();
    await expect(closing).resolves.toMatchObject({ exitCode: 0 });
    expect(observed.waits).toHaveLength(4);
    expect(observed.logConsumers).toHaveLength(4);
  });

  it("kills once, deletes the exact attempt after a throwing wait, and reports blocked cleanup during creation", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    observed.waitFailure = new Error("wait failed");
    await expect(provider.exec(workspace, { command: "true", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toThrow("wait failed");
    expect(observed.kills).toHaveLength(1);
    expect(observed.waits).toHaveLength(2);
    expect(observed.deletes).toEqual([workspace.providerWorkspaceId]);

    let release!: () => void;
    observed.createGate = new Promise<void>((resolve) => { release = resolve; });
    observed.waitFailure = undefined; observed.deleteFailure = new Error("delete refused");
    const controller = new AbortController();
    const aborted = provider.exec(workspace, { command: "sleep 1", timeoutMs: 1_000, maxOutputBytes: 1_000, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve)); controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "cleanup_blocked" });
    release();
  });

  it("bounds history pages, includes an active later page, and fails closed when completeness exceeds the ceiling", async () => {
    observed.listedPages = [Array.from({ length: 50 }, () => ({ status: "stopped" })), [{ status: "running" }]];
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    await provider.createWorkspace({ attemptKey: "later-page", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    expect(observed.listInputs[0]).toMatchObject({
      namePrefix: "jarvis",
      sortBy: "name",
      sortOrder: "asc",
      tags: { owner: "jarvis" },
      limit: 50,
      signal: expect.any(AbortSignal),
    });
    observed.listedPages = Array.from({ length: 9 }, () => []);
    await expect(provider.createWorkspace({ attemptKey: "too-many-pages", template: "node22", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS })).rejects.toMatchObject({ code: "resource_limit" });
  });

  it("aborts a stalled paginated list before create and returns a typed resumable timeout", async () => {
    observed.listedPages = [[], []];
    observed.listPageGate = new Promise<void>(() => undefined);
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider(
      "controller-token",
      "team_1",
      "prj_1",
      { listMs: 5, createMs: 50, controlMs: 50 },
    );
    await expect(provider.createWorkspace({
      attemptKey: "stalled-list",
      template: "node22",
      runtime: "node-22",
      lockfileDigest: "a".repeat(64),
      limits: DEFAULT_WORKSPACE_LIMITS,
    })).rejects.toMatchObject({ code: "timeout", disposition: "deferred" });
    expect(observed.listInputs[0]?.signal).toBeInstanceOf(AbortSignal);
    expect((observed.listInputs[0]?.signal as AbortSignal).aborted).toBe(true);
    expect(observed.create).toBeUndefined();
  });

  it("aborts and exact-cleans an uncertain create without changing its immutable name", async () => {
    let release!: () => void;
    observed.sandboxCreateGate = new Promise<void>((resolve) => { release = resolve; });
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider(
      "controller-token",
      "team_1",
      "prj_1",
      { listMs: 50, createMs: 5, controlMs: 50 },
    );
    const attemptKey = "stalled-create";
    const exactName = `jarvis-${createHash("sha256").update(attemptKey).digest("hex").slice(0, 40)}`;
    await expect(provider.createWorkspace({
      attemptKey,
      template: "node22",
      runtime: "node-22",
      lockfileDigest: "a".repeat(64),
      limits: DEFAULT_WORKSPACE_LIMITS,
    })).rejects.toMatchObject({ code: "timeout", disposition: "deferred" });
    expect(observed.create).toMatchObject({ name: exactName, signal: expect.any(AbortSignal) });
    expect((observed.create?.signal as AbortSignal).aborted).toBe(true);
    expect(observed.deletes).toEqual([exactName]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("reconciles an exact running attempt instead of blindly creating a duplicate", async () => {
    const attemptKey = "response-lost-create";
    const exactName = `jarvis-${createHash("sha256").update(attemptKey).digest("hex").slice(0, 40)}`;
    observed.listed = [{ name: exactName, status: "running" }];
    const { VercelCloudWorkspaceProvider } = await import("./cloud-workspace-providers");
    const provider = new VercelCloudWorkspaceProvider("controller-token", "team_1", "prj_1");
    await expect(provider.createWorkspace({
      attemptKey,
      template: "node22",
      runtime: "node-22",
      lockfileDigest: "a".repeat(64),
      limits: DEFAULT_WORKSPACE_LIMITS,
    })).resolves.toMatchObject({ providerWorkspaceId: exactName, providerSessionId: "vercel-session-a" });
    expect(observed.create).toBeUndefined();
    expect(observed.get).toMatchObject({ name: exactName, resume: false, signal: expect.any(AbortSignal) });
  });

  it("excludes the exact controller directory from baseline, checkpoint, replay, and exported patch commands", async () => {
    const { provider, workspace } = await providerAndWorkspace();
    const control = `.jarvis-controller-${workspace.providerWorkspaceId}`;
    const bytes = createDeterministicTar([{ path: "package.json", data: new TextEncoder().encode("{}") }]);
    await provider.uploadCredentiallessArchive(workspace, { baseSha: "0".repeat(40), sha256: sha256Bytes(bytes), bytes });
    observed.files.set(`${workspace.root}/${control}/source.tar`, Buffer.from(bytes));
    observed.files.set(`${workspace.root}/${control}/checkpoint.patch`, Buffer.alloc(0));
    await provider.checkpoint(workspace, { jobId: "job", attempt: 1, baseSha: "0".repeat(40), sourceArchiveSha256: sha256Bytes(bytes), sourceArchiveBytes: bytes.byteLength, runtime: "node-22", lockfileDigest: "a".repeat(64), template: "node22", attemptKey: "job", causationId: "cause" });
    observed.files.set(`${workspace.root}/${control}/output.patch`, Buffer.alloc(0));
    await provider.exportPatch(workspace, "0".repeat(40), DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
    const gitCommands = observed.commands.filter((command) => /git (?:add|diff)/.test(String(command.args))).map((command) => String(command.args));
    expect(gitCommands).not.toHaveLength(0);
    expect(gitCommands.every((command) => command.includes(`:(exclude)${control}`))).toBe(true);
  });
});
