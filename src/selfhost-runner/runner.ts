import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";

export const SELF_HOSTED_RUNNER_SERVER_PROTOCOL = "1.0.0";
export const SELF_HOSTED_RUNNER_WORKSPACE_ROOT = "/workspace/repository";
const RUNNER_ROOT = "/workspace";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 10_000;
const ATTEMPT = /^[A-Za-z0-9._:-]{1,240}$/;
const ID = /^[A-Za-z0-9._:-]{1,240}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type RunnerLimits = Readonly<{
  ttlMs: number;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxArchiveBytes: number;
  cpu: number;
  memoryMb: number;
}>;

export type SelfHostedRunnerConfig = Readonly<{
  token: string;
  stateDir: string;
  image: string;
  template: string;
  runtime: string;
  lockfileDigest: string;
  limits: RunnerLimits;
  maxActiveWorkspaces: number;
}>;

export type RunnerWorkspace = Readonly<{
  version: 1;
  workspaceId: string;
  sessionId: string;
  attemptKeyHash: string;
  policyDigest: string;
  containerId: string;
  createdAt: number;
  expiresAt: number;
  limits: RunnerLimits;
}>;

export interface SelfHostedRunnerBackend {
  create(workspaceId: string, limits: RunnerLimits): Promise<{ containerId: string }>;
  isRunning(workspace: RunnerWorkspace): Promise<boolean>;
  exec(workspace: RunnerWorkspace, request: {
    command: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  readFile(workspace: RunnerWorkspace, path: string, maxBytes: number): Promise<Uint8Array>;
  writeFile(workspace: RunnerWorkspace, path: string, value: Uint8Array, maxBytes: number): Promise<void>;
  listFiles(workspace: RunnerWorkspace, path: string, maxEntries: number): Promise<string[]>;
  remove(workspace: RunnerWorkspace): Promise<void>;
}

type RunnerState = {
  version: 1;
  workspaces: RunnerWorkspace[];
  tombstones: Array<{ workspaceId: string; sessionId: string; deletedAt: number }>;
};

class RunnerHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "RunnerHttpError";
  }
}

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunnerHttpError(400, "invalid_request");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new RunnerHttpError(400, "invalid_request");
}

function positiveInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new RunnerHttpError(400, "invalid_limit");
  }
  return Number(value);
}

function limitsFrom(value: unknown, ceilings: RunnerLimits): RunnerLimits {
  const input = record(value);
  exactKeys(input, ["ttlMs", "commandTimeoutMs", "maxOutputBytes", "maxFileBytes", "maxArchiveBytes", "cpu", "memoryMb"]);
  return {
    ttlMs: positiveInteger(input.ttlMs, ceilings.ttlMs),
    commandTimeoutMs: positiveInteger(input.commandTimeoutMs, ceilings.commandTimeoutMs),
    maxOutputBytes: positiveInteger(input.maxOutputBytes, ceilings.maxOutputBytes),
    maxFileBytes: positiveInteger(input.maxFileBytes, ceilings.maxFileBytes),
    maxArchiveBytes: positiveInteger(input.maxArchiveBytes, ceilings.maxArchiveBytes),
    cpu: positiveInteger(input.cpu, ceilings.cpu),
    memoryMb: positiveInteger(input.memoryMb, ceilings.memoryMb),
  };
}

function safeAbsoluteWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0") || !value.startsWith(`${RUNNER_ROOT}/`)) {
    throw new RunnerHttpError(400, "unsafe_path");
  }
  const normalized = posix.normalize(value);
  const harmlessDotSuffix = value === `${normalized}/.`;
  if ((!harmlessDotSuffix && normalized !== value) || normalized === RUNNER_ROOT || !normalized.startsWith(`${RUNNER_ROOT}/`)) {
    throw new RunnerHttpError(400, "unsafe_path");
  }
  return normalized;
}

function safeId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!ID.test(normalized)) throw new RunnerHttpError(400, "invalid_identity");
  return normalized;
}

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new RunnerHttpError(413, "body_too_large");
  const value = new Uint8Array(await request.arrayBuffer());
  if (value.byteLength > maxBytes) throw new RunnerHttpError(413, "body_too_large");
  return value;
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await boundedBody(request, MAX_JSON_BYTES);
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    throw new RunnerHttpError(400, "invalid_json");
  }
}

function stateRecord(value: unknown): RunnerState {
  const input = record(value);
  if (input.version !== 1 || !Array.isArray(input.workspaces) || !Array.isArray(input.tombstones)) {
    throw new Error("runner state is malformed");
  }
  const workspaces = input.workspaces.map((value) => {
    const row = record(value);
    if (row.version !== 1 || !ID.test(String(row.workspaceId)) || !ID.test(String(row.sessionId))
      || !SHA256.test(String(row.attemptKeyHash)) || !SHA256.test(String(row.policyDigest)) || !ID.test(String(row.containerId))
      || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt)) {
      throw new Error("runner workspace state is malformed");
    }
    return {
      version: 1 as const,
      workspaceId: String(row.workspaceId),
      sessionId: String(row.sessionId),
      attemptKeyHash: String(row.attemptKeyHash),
      policyDigest: String(row.policyDigest),
      containerId: String(row.containerId),
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
      limits: limitsFrom(row.limits, {
        ttlMs: 55 * 60_000,
        commandTimeoutMs: 15 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        maxFileBytes: 5 * 1024 * 1024,
        maxArchiveBytes: 25 * 1024 * 1024,
        cpu: 2,
        memoryMb: 4_096,
      }),
    } satisfies RunnerWorkspace;
  });
  const tombstones = input.tombstones.map((value) => {
    const row = record(value);
    if (!ID.test(String(row.workspaceId)) || !ID.test(String(row.sessionId)) || !Number.isSafeInteger(row.deletedAt)) {
      throw new Error("runner tombstone state is malformed");
    }
    return { workspaceId: String(row.workspaceId), sessionId: String(row.sessionId), deletedAt: Number(row.deletedAt) };
  });
  if (new Set(workspaces.map((row) => row.workspaceId)).size !== workspaces.length
    || new Set(workspaces.map((row) => row.attemptKeyHash)).size !== workspaces.length) {
    throw new Error("runner state contains duplicate identities");
  }
  return { version: 1, workspaces, tombstones };
}

export class SelfHostedRunnerService {
  private state: RunnerState = { version: 1, workspaces: [], tombstones: [] };
  private readonly statePath: string;
  private reaper?: ReturnType<typeof setInterval>;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly policyDigest: string;

  constructor(
    private readonly config: SelfHostedRunnerConfig,
    private readonly backend: SelfHostedRunnerBackend,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.token)) throw new Error("runner bearer must be 32+ base64url characters");
    if (!isAbsolute(config.stateDir) || config.stateDir === "/") throw new Error("runner state directory must be a narrow absolute path");
    this.statePath = `${config.stateDir.replace(/\/$/, "")}/runner-state.json`;
    this.policyDigest = createHash("sha256").update(JSON.stringify({
      image: config.image,
      template: config.template,
      runtime: config.runtime,
      lockfileDigest: config.lockfileDigest,
      limits: config.limits,
      maxActiveWorkspaces: config.maxActiveWorkspaces,
    })).digest("hex");
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    try { this.state = stateRecord(JSON.parse(await readFile(this.statePath, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
    await this.exclusive(async () => await this.reapUnlocked());
    this.reaper = setInterval(() => { void this.reap(); }, 30_000);
    this.reaper.unref();
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    await this.exclusive(async () => {
      const current = [...this.state.workspaces];
      for (const workspace of current) await this.deleteWorkspaceUnlocked(workspace).catch(() => undefined);
    });
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(action, action);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  private async deleteWorkspaceUnlocked(workspace: RunnerWorkspace): Promise<void> {
    await this.backend.remove(workspace);
    this.state.workspaces = this.state.workspaces.filter((entry) => entry.workspaceId !== workspace.workspaceId);
    this.state.tombstones = [
      { workspaceId: workspace.workspaceId, sessionId: workspace.sessionId, deletedAt: this.now() },
      ...this.state.tombstones.filter((entry) => entry.workspaceId !== workspace.workspaceId),
    ].slice(0, 256);
    await this.persist();
  }

  private async reapUnlocked(): Promise<void> {
    for (const workspace of [...this.state.workspaces]) {
      const expired = workspace.expiresAt <= this.now() || workspace.policyDigest !== this.policyDigest;
      let running = false;
      try { running = expired ? false : await this.backend.isRunning(workspace); }
      catch { continue; }
      if (expired || !running) await this.deleteWorkspaceUnlocked(workspace).catch(() => undefined);
    }
    const cutoff = this.now() - 24 * 60 * 60_000;
    const tombstones = this.state.tombstones.filter((entry) => entry.deletedAt >= cutoff).slice(0, 256);
    if (tombstones.length !== this.state.tombstones.length) {
      this.state.tombstones = tombstones;
      await this.persist();
    }
  }

  private async reap(): Promise<void> {
    await this.exclusive(async () => await this.reapUnlocked());
  }

  private authenticate(request: Request): void {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokenMatches(token, this.config.token)) throw new RunnerHttpError(401, "unauthorized");
    if (request.headers.get("x-jarvis-self-hosted-runner-protocol") !== SELF_HOSTED_RUNNER_SERVER_PROTOCOL) {
      throw new RunnerHttpError(409, "protocol_mismatch");
    }
  }

  private async workspace(workspaceId: string, sessionId: unknown): Promise<RunnerWorkspace> {
    const exactWorkspaceId = safeId(workspaceId);
    const exactSessionId = safeId(sessionId);
    const workspace = this.state.workspaces.find((entry) => entry.workspaceId === exactWorkspaceId);
    if (!workspace) throw new RunnerHttpError(404, "workspace_not_found");
    if (workspace.sessionId !== exactSessionId) throw new RunnerHttpError(409, "session_mismatch");
    if (workspace.expiresAt <= this.now()) {
      await this.exclusive(async () => {
        if (this.state.workspaces.some((entry) => entry.workspaceId === workspace.workspaceId)) {
          await this.deleteWorkspaceUnlocked(workspace);
        }
      }).catch(() => undefined);
      throw new RunnerHttpError(410, "workspace_expired");
    }
    return workspace;
  }

  private async createWorkspace(request: Request): Promise<Response> {
    const body = await boundedJson(request);
    exactKeys(body, ["attemptKey", "template", "runtime", "lockfileDigest", "limits"]);
    const attemptKey = typeof body.attemptKey === "string" ? body.attemptKey : "";
    if (!ATTEMPT.test(attemptKey)
      || body.template !== this.config.template
      || body.runtime !== this.config.runtime
      || body.lockfileDigest !== this.config.lockfileDigest
      || !SHA256.test(String(body.lockfileDigest))) {
      throw new RunnerHttpError(409, "workspace_policy_mismatch");
    }
    const limits = limitsFrom(body.limits, this.config.limits);
    const attemptKeyHash = createHash("sha256").update(attemptKey).digest("hex");
    return await this.exclusive(async () => {
      await this.reapUnlocked();
      const existing = this.state.workspaces.find((entry) => entry.attemptKeyHash === attemptKeyHash);
      if (existing) {
        if (existing.policyDigest !== this.policyDigest
          || JSON.stringify(existing.limits) !== JSON.stringify(limits)
          || !(await this.backend.isRunning(existing))) {
          throw new RunnerHttpError(409, "stale_attempt");
        }
        return json({ workspaceId: existing.workspaceId, sessionId: existing.sessionId, root: SELF_HOSTED_RUNNER_WORKSPACE_ROOT, createdAt: existing.createdAt });
      }
      if (this.state.workspaces.length >= this.config.maxActiveWorkspaces) throw new RunnerHttpError(429, "workspace_quota_exhausted");
      const workspaceId = `ws-${randomBytes(18).toString("base64url")}`;
      const sessionId = `session-${randomBytes(18).toString("base64url")}`;
      const createdAt = this.now();
      const created = await this.backend.create(workspaceId, limits);
      const workspace: RunnerWorkspace = {
        version: 1,
        workspaceId,
        sessionId,
        attemptKeyHash,
        policyDigest: this.policyDigest,
        containerId: safeId(created.containerId),
        createdAt,
        expiresAt: createdAt + limits.ttlMs,
        limits,
      };
      try {
        this.state.workspaces.push(workspace);
        await this.persist();
      } catch (error) {
        this.state.workspaces = this.state.workspaces.filter((entry) => entry.workspaceId !== workspaceId);
        await this.backend.remove(workspace).catch(() => undefined);
        throw error;
      }
      return json({ workspaceId, sessionId, root: SELF_HOSTED_RUNNER_WORKSPACE_ROOT, createdAt }, 201);
    });
  }

  private async workspaceRoute(request: Request, workspaceId: string, action: string): Promise<Response> {
    if (request.method === "DELETE" && !action) {
      const body = await boundedJson(request);
      exactKeys(body, ["sessionId", "reason"]);
      if (!["terminal", "orphan", "cancelled"].includes(String(body.reason))) throw new RunnerHttpError(400, "invalid_reason");
      const sessionId = safeId(body.sessionId);
      return await this.exclusive(async () => {
        const existing = this.state.workspaces.find((entry) => entry.workspaceId === workspaceId);
        if (!existing) {
          const deleted = this.state.tombstones.some((entry) => entry.workspaceId === workspaceId && entry.sessionId === sessionId);
          if (!deleted) throw new RunnerHttpError(404, "workspace_not_found");
          return new Response(null, { status: 204 });
        }
        if (existing.sessionId !== sessionId) throw new RunnerHttpError(409, "session_mismatch");
        await this.deleteWorkspaceUnlocked(existing);
        return new Response(null, { status: 204 });
      });
    }

    if (request.method === "GET" && action === "attestation") {
      const workspace = await this.workspace(workspaceId, request.headers.get("x-jarvis-workspace-session"));
      return json({
        protocolVersion: SELF_HOSTED_RUNNER_SERVER_PROTOCOL,
        workspaceId: workspace.workspaceId,
        sessionId: workspace.sessionId,
        state: "running",
        limits: { cpu: workspace.limits.cpu, memoryMb: workspace.limits.memoryMb, ttlMs: workspace.limits.ttlMs },
        quota: { maxActiveWorkspaces: this.config.maxActiveWorkspaces, activeWorkspaces: this.state.workspaces.length },
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

    if (request.method === "POST" && action === "exec") {
      const body = await boundedJson(request);
      exactKeys(body, ["sessionId", "command", "cwd", "timeoutMs", "maxOutputBytes"]);
      const workspace = await this.workspace(workspaceId, body.sessionId);
      if (body.cwd !== SELF_HOSTED_RUNNER_WORKSPACE_ROOT || typeof body.command !== "string" || !body.command || body.command.length > 128_000) {
        throw new RunnerHttpError(400, "invalid_command");
      }
      const timeoutMs = positiveInteger(body.timeoutMs, workspace.limits.commandTimeoutMs);
      const maxOutputBytes = positiveInteger(body.maxOutputBytes, workspace.limits.maxOutputBytes);
      const result = await this.backend.exec(workspace, { command: body.command, timeoutMs, maxOutputBytes, signal: request.signal });
      return json({ ...result, sessionId: workspace.sessionId });
    }

    if (action === "files" && request.method === "PUT") {
      const workspace = await this.workspace(workspaceId, request.headers.get("x-jarvis-workspace-session"));
      const path = safeAbsoluteWorkspacePath(request.headers.get("x-jarvis-workspace-path"));
      const maxBytes = positiveInteger(Number(request.headers.get("x-jarvis-max-bytes")), workspace.limits.maxArchiveBytes);
      const value = await boundedBody(request, maxBytes);
      await this.backend.writeFile(workspace, path, value, maxBytes);
      return new Response(null, { status: 204 });
    }

    if (action === "files" && request.method === "GET") {
      const workspace = await this.workspace(workspaceId, request.headers.get("x-jarvis-workspace-session"));
      const url = new URL(request.url);
      const path = safeAbsoluteWorkspacePath(url.searchParams.get("path"));
      const max = Number(url.searchParams.get("max"));
      if (request.headers.get("accept") === "application/json") {
        const maxEntries = positiveInteger(max, MAX_LIST_ENTRIES);
        const entries = await this.backend.listFiles(workspace, path, maxEntries);
        if (entries.length > maxEntries) throw new RunnerHttpError(413, "listing_too_large");
        return json({ entries });
      }
      const maxBytes = positiveInteger(max, workspace.limits.maxArchiveBytes);
      const value = await this.backend.readFile(workspace, path, maxBytes);
      if (value.byteLength > maxBytes) throw new RunnerHttpError(413, "file_too_large");
      return new Response(Buffer.from(value), {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": String(value.byteLength), "cache-control": "no-store" },
      });
    }
    throw new RunnerHttpError(404, "route_not_found");
  }

  async handle(request: Request): Promise<Response> {
    try {
      this.authenticate(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/workspaces") return await this.createWorkspace(request);
      const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)(?:\/(files|exec|attestation))?$/);
      if (!match) throw new RunnerHttpError(404, "route_not_found");
      return await this.workspaceRoute(request, decodeURIComponent(match[1]), match[2] ?? "");
    } catch (error) {
      if (error instanceof RunnerHttpError) return json({ error: error.code }, error.status);
      return json({ error: "runner_unavailable" }, 503);
    }
  }
}

export async function removeRunnerStateDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
