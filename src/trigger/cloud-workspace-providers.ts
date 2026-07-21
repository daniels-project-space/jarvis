import { createHash, randomUUID } from "node:crypto";
import type { Sandbox as E2BSandbox } from "e2b";
import type { Client as Sandbox0Client, Sandbox as Sandbox0Sandbox } from "sandbox0";
import type { Command as VercelCommand, Sandbox as VercelSandbox, Session as VercelSession } from "@vercel/sandbox";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  assertRequiredCapabilities,
  assertWorkspaceIdentity,
  createPortableCheckpointArchive,
  sha256Bytes,
  validateCredentiallessArchive,
  validatePatchManifest,
  validatePortableCheckpointArchive,
  validateRelativePath,
  type CloudWorkspace,
  type CloudWorkspaceCapabilities,
  type CloudWorkspaceProvider,
  type CloudWorkspaceProviderName,
  type HistoricalCloudWorkspaceProviderName,
  type CredentiallessArchive,
  type ExecRequest,
  type ExecResult,
  type PatchManifest,
  type WorkspaceCheckpoint,
  type WorkspaceLimits,
} from "./cloud-workspace";
import {
  assertCloudProviderExecutionReady,
  type CloudProviderRuntimeAttestation,
} from "./cloud-provider-probe-attestation";

const ROOT = "/workspace/repository";
const CHECKPOINT_EXCLUDES = [
  ".git", "node_modules", ".next", ".turbo", ".cache", ".npm", ".pnpm-store",
  "coverage", "dist", "build", "tmp", "temp", ".trigger", ".vercel",
];

const CAPABILITIES: Record<CloudWorkspaceProviderName, CloudWorkspaceCapabilities> = {
  e2b: {
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    emptyEnvironment: true, boundedResources: false, boundedTtl: true,
    exactCommandCancellation: true, sameWorkspaceResume: true, portableCheckpointReplay: true,
    providerSnapshots: true, persistentVolumes: true, opaqueSecretProjection: false,
  },
  sandbox0: {
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    emptyEnvironment: true, boundedResources: true, boundedTtl: true,
    exactCommandCancellation: true, sameWorkspaceResume: true, portableCheckpointReplay: true,
    providerSnapshots: true, persistentVolumes: true, opaqueSecretProjection: true,
  },
  vercel: {
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    emptyEnvironment: true, boundedResources: true, boundedTtl: true,
    exactCommandCancellation: true, sameWorkspaceResume: false, portableCheckpointReplay: true,
    providerSnapshots: false, persistentVolumes: false, opaqueSecretProjection: false,
  },
  cloudflare: {
    // This is deliberately only a compatibility seam until a concrete client
    // is injected and probed; an absent seam must not advertise capabilities.
    credentiallessArchive: false, privateIngress: false, networkDenyByDefault: false,
    emptyEnvironment: false, boundedResources: false, boundedTtl: false,
    exactCommandCancellation: false, sameWorkspaceResume: false, portableCheckpointReplay: false,
    providerSnapshots: false, persistentVolumes: false, opaqueSecretProjection: false,
  },
};

export const CLOUD_WORKSPACE_CAPABILITY_MATRIX = CAPABILITIES;

function safeWorkspacePath(workspace: CloudWorkspace, path: string): string {
  const relative = validateRelativePath(path, workspace.provider);
  return `${workspace.root}/${relative}`;
}

function outputLimit(value: string, maxBytes: number, provider: CloudWorkspaceProviderName): string {
  if (Buffer.byteLength(value) > maxBytes) {
    throw new CloudWorkspaceError(provider, "resource_limit", "sandbox command output exceeded its byte limit", "rejected");
  }
  return value;
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

type ProviderPaths = Readonly<{
  root: string; archivePath: string; controlDir: string; sourcePath: string;
  checkpointPatchPath: string; replayStage: string; replayPath: string; patchPath: string;
}>;

function providerPaths(root: string): ProviderPaths {
  const parent = root.slice(0, root.lastIndexOf("/"));
  const controlDir = `${parent}/.jarvis`;
  return {
    root, archivePath: `${parent}/jarvis-source.tar`, controlDir,
    sourcePath: `${controlDir}/source.tar`, checkpointPatchPath: `${controlDir}/checkpoint.patch`,
    replayStage: `${controlDir}/replay-stage`, replayPath: `${controlDir}/replay.tar`, patchPath: `${controlDir}/output.patch`,
  };
}

function hydrateCommand(paths: ProviderPaths): string {
  return [
    `mkdir -p ${paths.root} ${paths.controlDir}`,
    `tar --no-same-owner --no-same-permissions -xf ${paths.archivePath} -C ${paths.root}`,
    `mv ${paths.archivePath} ${paths.sourcePath}`,
    `cd ${paths.root}`,
    "git init -q",
    "git config user.email jarvis-controller@example.invalid",
    "git config user.name 'JARVIS controller baseline'",
    "git add -A",
    "git commit -q --allow-empty -m 'credentialless controller baseline'",
    "git update-ref refs/jarvis/controller-base HEAD",
  ].join(" && ");
}

async function checkpointThroughProvider(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
  readArtifact: (path: string, maxBytes: number) => Promise<Uint8Array>,
  input: {
    jobId: string; attempt: number; baseSha: string; sourceArchiveSha256: string; sourceArchiveBytes: number;
    runtime: string; lockfileDigest: string; template: string; attemptKey: string; causationId: string;
  },
  paths: ProviderPaths,
): Promise<{ manifest: WorkspaceCheckpoint; archive: Uint8Array }> {
  const excludes = CHECKPOINT_EXCLUDES.map((path) => `':(exclude)${path}' ":(exclude)${path}/**"`).join(" ");
  const result = await provider.exec(workspace, {
    command: [
      `mkdir -p ${paths.controlDir}`,
      `rm -f ${paths.checkpointPatchPath}`,
      `cd ${paths.root}`,
      `git add -N -A -- . ${excludes}`,
      `git diff --binary --no-ext-diff --no-color --no-renames --full-index refs/jarvis/controller-base -- . ${excludes} > ${paths.checkpointPatchPath}`,
      `git reset -q HEAD -- .`,
    ].join(" && "),
    cwd: paths.root,
    timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
    maxOutputBytes: 16_384,
  });
  if (result.exitCode !== 0) throw new CloudWorkspaceError(provider.name, "provider_unavailable", "portable checkpoint export failed", "deferred");
  const sourceBytes = await readArtifact(paths.sourcePath, DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
  if (sourceBytes.byteLength !== input.sourceArchiveBytes || sha256Bytes(sourceBytes) !== input.sourceArchiveSha256) {
    throw new CloudWorkspaceError(provider.name, "checkpoint_tampered", "sandbox source archive changed before checkpoint", "rejected");
  }
  const patch = await readArtifact(paths.checkpointPatchPath, DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
  const archive = createPortableCheckpointArchive({
    baseSha: input.baseSha, sha256: input.sourceArchiveSha256, bytes: sourceBytes,
  }, patch);
  const manifest: WorkspaceCheckpoint = {
    version: 2,
    jobId: input.jobId,
    attempt: input.attempt,
    provider: provider.name,
    providerWorkspaceId: workspace.providerWorkspaceId,
    providerSessionId: workspace.providerSessionId,
    baseSha: input.baseSha,
    sourceArchiveSha256: input.sourceArchiveSha256,
    sourceArchiveBytes: input.sourceArchiveBytes,
    archiveSha256: sha256Bytes(archive),
    archiveBytes: archive.byteLength,
    runtime: input.runtime,
    lockfileDigest: input.lockfileDigest,
    template: input.template,
    attemptKey: input.attemptKey,
    causationId: input.causationId,
    createdAt: Date.now(),
  };
  validatePortableCheckpointArchive(archive, manifest);
  return { manifest, archive };
}

async function exportPatchThroughProvider(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
  readArtifact: (path: string, maxBytes: number) => Promise<Uint8Array>,
  baseSha: string,
  maxBytes: number,
  paths: ProviderPaths,
): Promise<PatchManifest> {
  const result = await provider.exec(workspace, {
    command: `mkdir -p ${paths.controlDir} && rm -f ${paths.patchPath} && git add -N . && git diff --binary --no-ext-diff refs/jarvis/controller-base > ${paths.patchPath}`,
    cwd: paths.root,
    timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
    maxOutputBytes: 16_384,
  });
  if (result.exitCode !== 0) throw new CloudWorkspaceError(provider.name, "provider_unavailable", "patch export failed", "deferred");
  const patch = await readArtifact(paths.patchPath, maxBytes);
  const manifest = { baseSha, sha256: sha256Bytes(patch), byteCount: patch.byteLength, patch };
  validatePatchManifest(manifest, baseSha, maxBytes, provider.name);
  return manifest;
}

abstract class ProviderBase implements CloudWorkspaceProvider {
  abstract readonly name: CloudWorkspaceProviderName;
  abstract readonly capabilities: CloudWorkspaceCapabilities;
  abstract createWorkspace(input: { attemptKey: string; template: string; runtime: string; lockfileDigest: string; limits: WorkspaceLimits }): Promise<CloudWorkspace>;
  abstract exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult>;
  abstract readFile(workspace: CloudWorkspace, path: string, maxBytes: number): Promise<Uint8Array>;
  abstract writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number): Promise<void>;
  abstract listFiles(workspace: CloudWorkspace, path: string, maxEntries: number): Promise<string[]>;
  abstract terminate(workspace: CloudWorkspace, reason: "terminal" | "orphan" | "cancelled"): Promise<void>;
  protected workspaceRoot = ROOT;
  protected get paths() { return providerPaths(this.workspaceRoot); }

  async uploadCredentiallessArchive(workspace: CloudWorkspace, archive: CredentiallessArchive): Promise<void> {
    validateCredentiallessArchive(archive, DEFAULT_WORKSPACE_LIMITS, this.name);
    await this.writeAbsolute(workspace, this.paths.archivePath, archive.bytes, DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
    const result = await this.exec(workspace, {
      command: hydrateCommand(this.paths), cwd: workspace.root, timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
      maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes,
    });
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "credentialless archive hydration failed", "deferred");
  }

  async checkpoint(workspace: CloudWorkspace, input: {
    jobId: string; attempt: number; baseSha: string; sourceArchiveSha256: string; sourceArchiveBytes: number;
    runtime: string; lockfileDigest: string; template: string; attemptKey: string; causationId: string;
  }) { return checkpointThroughProvider(this, workspace, (path, maxBytes) => this.readAbsolute(workspace, path, maxBytes), input, this.paths); }

  async recreateFromCheckpoint(input: { checkpoint: WorkspaceCheckpoint; archive: Uint8Array; limits: WorkspaceLimits; attemptKey: string }) {
    validatePortableCheckpointArchive(input.archive, input.checkpoint, input.limits);
    const workspace = await this.createWorkspace({
      attemptKey: input.attemptKey,
      template: input.checkpoint.template,
      runtime: input.checkpoint.runtime,
      lockfileDigest: input.checkpoint.lockfileDigest,
      limits: input.limits,
    });
    await this.writeAbsolute(workspace, this.paths.replayPath, input.archive, input.limits.maxArchiveBytes);
    const result = await this.exec(workspace, {
      command: [
        `rm -rf ${this.paths.root} ${this.paths.replayStage}`,
        `mkdir -p ${this.paths.root} ${this.paths.replayStage}`,
        `tar --no-same-owner --no-same-permissions -xf ${this.paths.replayPath} -C ${this.paths.replayStage}`,
        `mv ${this.paths.replayStage}/source.tar ${this.paths.sourcePath}`,
        `tar --no-same-owner --no-same-permissions -xf ${this.paths.sourcePath} -C ${this.paths.root}`,
        `cd ${this.paths.root}`,
        "git init -q",
        "git config user.email jarvis-controller@example.invalid",
        "git config user.name 'JARVIS controller baseline'",
        "git add -A",
        "git commit -q --allow-empty -m 'credentialless controller baseline'",
        "git update-ref refs/jarvis/controller-base HEAD",
        `git apply --whitespace=nowarn ${this.paths.replayStage}/workspace.patch`,
        `rm -rf ${this.paths.replayStage} ${this.paths.replayPath}`,
      ].join(" && "),
      cwd: workspace.root, timeoutMs: input.limits.commandTimeoutMs, maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      await this.terminate(workspace, "terminal").catch(() => undefined);
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "portable checkpoint replay failed", "deferred");
    }
    return workspace;
  }

  async exportPatch(workspace: CloudWorkspace, baseSha: string, maxBytes: number) {
    return exportPatchThroughProvider(this, workspace, (path, limit) => this.readAbsolute(workspace, path, limit), baseSha, maxBytes, this.paths);
  }

  protected abstract readAbsolute(workspace: CloudWorkspace, path: string, maxBytes: number): Promise<Uint8Array>;
  protected abstract writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number): Promise<void>;
}

class E2BCloudWorkspaceProvider extends ProviderBase {
  readonly name = "e2b" as const;
  readonly capabilities = CAPABILITIES.e2b;
  private readonly sandboxes = new Map<string, E2BSandbox>();

  constructor(private readonly apiKey: string) { super(); }

  async createWorkspace(input: { attemptKey: string; template: string; runtime: string; lockfileDigest: string; limits: WorkspaceLimits }) {
    if (!this.apiKey) throw new CloudWorkspaceError(this.name, "missing_configuration", "E2B_API_KEY is not configured");
    if (!this.capabilities.boundedResources) {
      throw new CloudWorkspaceError(this.name, "capability_unsupported", "E2B SDK 2.35.0 does not expose per-sandbox CPU/memory bounds", "blocked");
    }
    const { Sandbox } = await import("e2b");
    const sandbox = await Sandbox.create(input.template || "base", {
      apiKey: this.apiKey,
      secure: true,
      allowInternetAccess: false,
      envs: {},
      timeoutMs: Math.min(input.limits.ttlMs, 60 * 60_000),
      lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
      metadata: { owner: "jarvis", attempt: input.attemptKey.slice(0, 80), runtime: input.runtime.slice(0, 40), lockfile: input.lockfileDigest.slice(0, 64) },
    });
    const workspace: CloudWorkspace = {
      provider: this.name, providerWorkspaceId: sandbox.sandboxId,
      providerSessionId: `e2b-session-${randomUUID()}`, root: this.workspaceRoot, createdAt: Date.now(),
    };
    assertWorkspaceIdentity(workspace);
    this.sandboxes.set(workspace.providerWorkspaceId, sandbox);
    return workspace;
  }

  async exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult> {
    const sandbox = await this.get(workspace);
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();
    const handle = await sandbox.commands.run(request.command, {
      background: true,
      cwd: request.cwd ?? workspace.root,
      envs: {},
      timeoutMs: request.timeoutMs,
      onStdout: (chunk) => { stdout = outputLimit(stdout + chunk, request.maxOutputBytes, this.name); },
      onStderr: (chunk) => { stderr = outputLimit(stderr + chunk, request.maxOutputBytes, this.name); },
    });
    const abort = () => { void handle.kill(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await handle.wait().catch((error: unknown) => ({
        exitCode: typeof error === "object" && error && "exitCode" in error ? Number(error.exitCode) : -1,
        stdout, stderr,
      }));
      if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      return { exitCode: result.exitCode, stdout, stderr, providerSessionId: workspace.providerSessionId, durationMs: Date.now() - startedAt };
    } finally { request.signal?.removeEventListener("abort", abort); }
  }

  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number) {
    return this.readAbsolute(workspace, safeWorkspacePath(workspace, path), maxBytes);
  }
  protected async readAbsolute(workspace: CloudWorkspace, path: string, maxBytes: number) {
    const bytes = await (await this.get(workspace)).files.read(path, { format: "bytes" });
    if (bytes.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected");
    return bytes;
  }
  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) {
    return this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes);
  }
  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) {
    if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected");
    await (await this.get(workspace)).files.write(path, Uint8Array.from(data).buffer);
  }
  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number) {
    const entries = await (await this.get(workspace)).files.list(safeWorkspacePath(workspace, path));
    if (entries.length > maxEntries) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected");
    return entries.map((entry) => entry.name);
  }
  async terminate(workspace: CloudWorkspace) { await (await this.get(workspace)).kill(); this.sandboxes.delete(workspace.providerWorkspaceId); }
  private async get(workspace: CloudWorkspace): Promise<E2BSandbox> {
    assertWorkspaceIdentity(workspace);
    const cached = this.sandboxes.get(workspace.providerWorkspaceId);
    if (cached) return cached;
    const { Sandbox } = await import("e2b");
    const connected = await Sandbox.connect(workspace.providerWorkspaceId, { apiKey: this.apiKey, timeoutMs: DEFAULT_WORKSPACE_LIMITS.ttlMs });
    this.sandboxes.set(workspace.providerWorkspaceId, connected);
    return connected;
  }
}

class Sandbox0CloudWorkspaceProvider extends ProviderBase {
  readonly name = "sandbox0" as const;
  readonly capabilities = CAPABILITIES.sandbox0;
  private client?: Sandbox0Client;
  private readonly sandboxes = new Map<string, Sandbox0Sandbox>();
  constructor(private readonly token: string, private readonly baseUrl?: string) { super(); }

  async createWorkspace(input: { attemptKey: string; template: string; runtime: string; lockfileDigest: string; limits: WorkspaceLimits }) {
    if (!this.token) throw new CloudWorkspaceError(this.name, "missing_configuration", "SANDBOX0_TOKEN is not configured");
    const sandbox = await (await this.getClient()).sandboxes.claim(input.template, {
      config: {
        envVars: {}, resources: { memory: `${input.limits.memoryMb}Mi` },
        ttl: Math.max(60, Math.floor(input.limits.ttlMs / 1000)),
        hardTtl: Math.max(120, Math.floor(input.limits.ttlMs / 1000) + 300),
        network: { mode: "block-all", credentialBindings: [] }, autoResume: false, services: [],
      },
    });
    const workspace = { provider: this.name, providerWorkspaceId: sandbox.id, providerSessionId: `sandbox0-context-${randomUUID()}`, root: this.workspaceRoot, createdAt: Date.now() } satisfies CloudWorkspace;
    assertWorkspaceIdentity(workspace);
    this.sandboxes.set(sandbox.id, sandbox);
    return workspace;
  }
  async exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult> {
    const sandbox = await this.get(workspace);
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    const startedAt = Date.now();
    const stream = await sandbox.cmdStream(request.command, {
      cwd: request.cwd ?? workspace.root, envVars: {}, wait: false,
      idleTimeoutSec: Math.max(1, Math.ceil(request.timeoutMs / 1000)), ttlSec: Math.max(1, Math.ceil(request.timeoutMs / 1000)),
    });
    let stdout = "";
    let stderr = "";
    const abort = () => stream.sendSignal("SIGKILL");
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream.outputs()) {
        if (chunk.source === "stderr") stderr = outputLimit(stderr + chunk.data, request.maxOutputBytes, this.name);
        else stdout = outputLimit(stdout + chunk.data, request.maxOutputBytes, this.name);
      }
      const done = await stream.wait();
      if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      return { exitCode: done.exitCode ?? -1, stdout, stderr, providerSessionId: workspace.providerSessionId, durationMs: Date.now() - startedAt };
    } finally { request.signal?.removeEventListener("abort", abort); stream.close(); }
  }
  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number) { return this.readAbsolute(workspace, safeWorkspacePath(workspace, path), maxBytes); }
  protected async readAbsolute(workspace: CloudWorkspace, path: string, maxBytes: number) { const bytes = await (await this.get(workspace)).readFile(path); if (bytes.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected"); return bytes; }
  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { return this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes); }
  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected"); await (await this.get(workspace)).writeFile(path, data); }
  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number) { const entries = await (await this.get(workspace)).listFiles(safeWorkspacePath(workspace, path)); if (entries.length > maxEntries) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected"); if (entries.some((entry) => entry.isLink)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "symlink encountered during bounded listing", "rejected"); return entries.map((entry) => String(entry.path ?? entry.name ?? "")); }
  async terminate(workspace: CloudWorkspace) { await (await this.getClient()).sandboxes.delete(workspace.providerWorkspaceId); this.sandboxes.delete(workspace.providerWorkspaceId); }
  private async getClient() { if (!this.client) { const { Client } = await import("sandbox0"); this.client = new Client({ token: this.token, baseUrl: this.baseUrl }); } return this.client; }
  private async get(workspace: CloudWorkspace) { assertWorkspaceIdentity(workspace); const cached = this.sandboxes.get(workspace.providerWorkspaceId); if (cached) return cached; const sandbox = (await this.getClient()).sandbox(workspace.providerWorkspaceId); this.sandboxes.set(workspace.providerWorkspaceId, sandbox); return sandbox; }
}

const VERCEL_SAFE_TTL_MS = 44 * 60_000;
const VERCEL_NPM_POLICY = Object.freeze({ allow: ["registry.npmjs.org"] });
/** Must never exceed the durable Trigger agent-worker fleet concurrency (8). */
export const VERCEL_ACTIVE_SANDBOX_CAP = 8;
const VERCEL_NAME_PREFIX = "jarvis";

function vercelWorkspaceName(attemptKey: string): string {
  // Vercel names are persisted identities, so never derive one from an
  // unbounded job string or reuse it after a terminated attempt.
  return `${VERCEL_NAME_PREFIX}-${createHash("sha256").update(`${attemptKey}:${randomUUID()}`).digest("hex").slice(0, 40)}`;
}

function vercelCwd(workspace: CloudWorkspace, cwd: string | undefined): string {
  const value = cwd ?? workspace.root;
  if (value !== workspace.root && !value.startsWith(`${workspace.root}/`)) {
    throw new CloudWorkspaceError("vercel", "unsafe_archive", "command cwd escapes the workspace root", "rejected");
  }
  return value;
}

function vercelAbsolutePath(workspace: CloudWorkspace, value: string): string {
  if (value === workspace.root || value.startsWith(`${workspace.root}/`)) return value;
  return safeWorkspacePath(workspace, value);
}

function decodeOutput(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new CloudWorkspaceError("vercel", "unsafe_patch", "sandbox emitted invalid UTF-8 output", "rejected"); }
}

function packageLockUsesOnlyNpmRegistry(bytes: Uint8Array): boolean {
  let lock: unknown;
  try { lock = JSON.parse(new TextDecoder().decode(bytes)); } catch { return false; }
  const urls: string[] = [];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "resolved" && typeof item === "string") urls.push(item);
      else collect(item);
    }
  };
  collect(lock);
  return urls.length > 0 && urls.every((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.hostname === "registry.npmjs.org";
    } catch { return false; }
  });
}

/**
 * Vercel Sandbox adapter. Credentials are passed only to SDK control-plane
 * calls; neither Sandbox nor command environments receive them.
 */
export class VercelCloudWorkspaceProvider extends ProviderBase {
  readonly name = "vercel" as const;
  readonly capabilities = CAPABILITIES.vercel;
  protected override workspaceRoot = "/vercel/sandbox/repository";
  private readonly sandboxes = new Map<string, VercelSandbox>();

  constructor(
    private readonly token: string,
    private readonly teamId: string,
    private readonly projectId: string,
  ) { super(); }

  private credentials() { return { token: this.token, teamId: this.teamId, projectId: this.projectId }; }

  async createWorkspace(input: { attemptKey: string; template: string; runtime: string; lockfileDigest: string; limits: WorkspaceLimits }) {
    const { Sandbox } = await import("@vercel/sandbox");
    const listed = await Sandbox.list({ ...this.credentials(), namePrefix: VERCEL_NAME_PREFIX });
    let active = 0;
    for await (const item of listed) {
      if (["pending", "running", "stopping"].includes(item.status)) active += 1;
      if (active >= VERCEL_ACTIVE_SANDBOX_CAP) {
        throw new CloudWorkspaceError(this.name, "resource_limit", "Vercel Sandbox controller active-attempt cap is reached", "deferred");
      }
    }
    const sandbox = await Sandbox.create({
      ...this.credentials(),
      name: vercelWorkspaceName(input.attemptKey),
      runtime: "node22",
      // Deliberately no source, ports, or authority-shaped environment.
      env: {}, ports: [], networkPolicy: "deny-all", resources: { vcpus: 2 },
      timeout: Math.min(input.limits.ttlMs, VERCEL_SAFE_TTL_MS),
      persistent: false,
      tags: {
        owner: "jarvis",
        attempt: createHash("sha256").update(input.attemptKey).digest("hex").slice(0, 32),
        runtime: "node22",
      },
    });
    const session = sandbox.currentSession();
    if (sandbox.routes.length || sandbox.runtime !== "node22" || sandbox.vcpus !== 2 || sandbox.memory !== 4096
      || sandbox.networkPolicy !== "deny-all" || session.networkPolicy !== "deny-all") {
      await sandbox.delete().catch(() => undefined);
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "Vercel Sandbox creation did not preserve private bounded deny-all configuration", "blocked");
    }
    const workspace = { provider: this.name, providerWorkspaceId: sandbox.name, providerSessionId: session.sessionId, root: this.workspaceRoot, createdAt: Date.now() } satisfies CloudWorkspace;
    assertWorkspaceIdentity(workspace);
    this.sandboxes.set(workspace.providerWorkspaceId, sandbox);
    return workspace;
  }

  async exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult> {
    const sandbox = await this.get(workspace);
    const session = this.assertSession(workspace, sandbox);
    const result = await this.runSessionCommand(workspace, sandbox, session, {
      command: request.command, cwd: vercelCwd(workspace, request.cwd), timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes, signal: request.signal,
    });
    return { exitCode: result.exitCode, stdout: decodeOutput(result.stdout), stderr: decodeOutput(result.stderr), providerSessionId: workspace.providerSessionId, durationMs: result.durationMs };
  }

  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number) { return this.readAbsolute(workspace, safeWorkspacePath(workspace, path), maxBytes); }
  protected async readAbsolute(workspace: CloudWorkspace, path: string, maxBytes: number) {
    const sandbox = await this.get(workspace); const session = this.assertSession(workspace, sandbox);
    const absolute = vercelAbsolutePath(workspace, path);
    await this.assertNoSymlink(workspace, sandbox, session, absolute, false);
    const stream = await session.readFile({ path: absolute });
    if (!stream) throw new CloudWorkspaceError(this.name, "provider_unavailable", "sandbox file is missing", "deferred");
    const chunks: Buffer[] = []; let used = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (chunk.byteLength > maxBytes - used) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected");
        chunks.push(chunk); used += chunk.byteLength;
      }
    } finally { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); }
    this.assertSession(workspace, sandbox); return new Uint8Array(Buffer.concat(chunks, used));
  }
  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { return this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes); }
  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) {
    if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected");
    const sandbox = await this.get(workspace); const session = this.assertSession(workspace, sandbox);
    const absolute = vercelAbsolutePath(workspace, path);
    await this.assertNoSymlink(workspace, sandbox, session, absolute, true);
    await session.writeFiles([{ path: absolute, content: data }]); this.assertSession(workspace, sandbox);
  }
  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing limit is invalid", "rejected");
    const sandbox = await this.get(workspace); const session = this.assertSession(workspace, sandbox);
    const base = vercelAbsolutePath(workspace, path);
    await this.assertNoSymlink(workspace, sandbox, session, base, false);
    const script = [
      `base=${shellQuote(base)}`,
      `count=$(find -P -- "$base" -mindepth 1 -maxdepth 1 -printf . | wc -c)`,
      `[ "$count" -le ${maxEntries} ] || exit 42`,
      `find -P -- "$base" -mindepth 1 -maxdepth 1 -exec sh -c 'for entry do [ ! -L "$entry" ] || exit 43; stat -c %F -- "$entry" | grep -qx "symbolic link" && exit 43; done' sh {} +`,
      `find -P -- "$base" -mindepth 1 -maxdepth 1 -printf '%f\\0'`,
    ].join("; ");
    const result = await this.runSessionCommand(workspace, sandbox, session, { command: script, cwd: workspace.root, timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs, maxOutputBytes: Math.max(1_024, Math.min(DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, maxEntries * 512)) });
    if (result.exitCode === 42) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected");
    if (result.exitCode === 43) throw new CloudWorkspaceError(this.name, "unsafe_archive", "symlink encountered during bounded listing", "rejected");
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "sandbox file listing failed", "deferred");
    const names = result.stdout.subarray(0, result.stdout.byteLength && result.stdout[result.stdout.byteLength - 1] === 0 ? -1 : result.stdout.byteLength).toString("utf8").split("\0").filter(Boolean);
    if (names.length > maxEntries || names.some((name) => validateRelativePath(name, this.name) !== name)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "sandbox listing contains an unsafe entry", "rejected");
    this.assertSession(workspace, sandbox); return names;
  }

  async hydrateDependencies(workspace: CloudWorkspace): Promise<void> {
    // Source has already been validated and uploaded. This parses only the
    // committed lockfile, opens one registry for one command, then relocks.
    try {
      const sandbox = await this.get(workspace); const session = this.assertSession(workspace, sandbox);
      try {
      const lockPath = `${this.workspaceRoot}/package-lock.json`;
      // A missing lock means no egress. Verify its parent/final path without
      // following a link before deciding whether there is anything to read.
      await this.assertNoSymlink(workspace, sandbox, session, lockPath, true);
      const exists = await this.runSessionCommand(workspace, sandbox, session, { command: `test -f ${shellQuote(lockPath)}`, cwd: this.workspaceRoot, timeoutMs: 10_000, maxOutputBytes: 4_000 });
      if (exists.exitCode === 1) return;
      if (exists.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "could not inspect committed package lock", "deferred");
      const lock = await this.readAbsolute(workspace, lockPath, DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
      if (!packageLockUsesOnlyNpmRegistry(lock)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "package lock contains a non-npm-registry dependency", "rejected");
      await session.update({ networkPolicy: VERCEL_NPM_POLICY }); this.assertSession(workspace, sandbox);
      const installed = await this.runSessionCommand(workspace, sandbox, session, {
        command: "npm ci --ignore-scripts --no-audit --no-fund --cache /vercel/sandbox/.jarvis-npm-cache && git reset --hard refs/jarvis/controller-base && git clean -ffdX -e node_modules && git clean -ffd -e node_modules && rm -rf -- /vercel/sandbox/.jarvis-npm-cache",
        cwd: this.workspaceRoot, timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs, maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes,
      });
      if (installed.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "deterministic dependency hydration failed", "deferred");
      } finally {
        await session.update({ networkPolicy: "deny-all" });
      }
      this.assertSession(workspace, sandbox);
      if (session.networkPolicy !== "deny-all") throw new CloudWorkspaceError(this.name, "provider_unavailable", "dependency hydration did not relock deny-all egress", "blocked");
      const denied = await this.exec(workspace, { command: "node -e 'fetch(\"https://example.com\",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(9),()=>process.exit(0))'", cwd: this.workspaceRoot, timeoutMs: 8_000, maxOutputBytes: 4_000 });
      if (denied.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "deny-all network verification failed after dependency hydration", "blocked");
    } catch (error) {
      await this.terminate(workspace).catch(() => undefined);
      throw error;
    }
  }

  async terminate(workspace: CloudWorkspace) {
    try {
      const sandbox = await this.get(workspace);
      // Cleanup owns only the random attempt name. It must never start a
      // session, and a substituted/stopped session cannot block deletion.
      await sandbox.delete();
    } catch (error) {
      if (this.absent(error)) return;
      throw error;
    } finally { this.sandboxes.delete(workspace.providerWorkspaceId); }
  }

  private absent(error: unknown): boolean { return /(?:not[_ -]?found|404|already deleted)/i.test(String(error)); }
  private async get(workspace: CloudWorkspace): Promise<VercelSandbox> {
    assertWorkspaceIdentity(workspace);
    const cached = this.sandboxes.get(workspace.providerWorkspaceId);
    if (cached) return cached;
    const { Sandbox } = await import("@vercel/sandbox");
    const sandbox = await Sandbox.get({ ...this.credentials(), name: workspace.providerWorkspaceId, resume: false });
    this.sandboxes.set(workspace.providerWorkspaceId, sandbox); return sandbox;
  }
  private assertSession(workspace: CloudWorkspace, sandbox: VercelSandbox) {
    const session = sandbox.currentSession();
    if (session.sessionId !== workspace.providerSessionId || session.status !== "running") {
      throw new CloudWorkspaceError(this.name, "stale_attempt", "Vercel Sandbox session changed or stopped for this attempt", "deferred");
    }
    return session;
  }

  private async assertNoSymlink(workspace: CloudWorkspace, sandbox: VercelSandbox, session: VercelSession, path: string, writing: boolean): Promise<void> {
    if (path !== workspace.root && !path.startsWith(`${workspace.root}/`)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "sandbox path escapes the workspace root", "rejected");
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const check = writing
      ? `[ "$(realpath -e -- ${shellQuote(parent)})" = ${shellQuote(parent)} ] && { [ ! -e ${shellQuote(path)} ] || [ ! -L ${shellQuote(path)} ]; }`
      : `[ "$(realpath -e -- ${shellQuote(path)})" = ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ]`;
    const result = await this.runSessionCommand(workspace, sandbox, session, { command: check, cwd: workspace.root, timeoutMs: 10_000, maxOutputBytes: 4_000 });
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "unsafe_archive", "sandbox path is missing, symlinked, or escapes the workspace root", "rejected");
  }

  private async runSessionCommand(
    workspace: CloudWorkspace, sandbox: VercelSandbox, session: VercelSession,
    request: { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; durationMs: number }> {
    this.assertSession(workspace, sandbox);
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    const startedAt = Date.now();
    let command: VercelCommand | undefined;
    let reason: "cancelled" | "timeout" | "resource_limit" | undefined;
    let termination: Promise<void> | undefined;
    const logAbort = new AbortController();
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let stdoutBytes = 0; let stderrBytes = 0;
    const append = (stream: "stdout" | "stderr", data: string) => {
      const chunk = Buffer.from(data); const remaining = request.maxOutputBytes - bytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          (stream === "stdout" ? stdout : stderr).push(chunk.subarray(0, remaining));
          if (stream === "stdout") stdoutBytes += remaining; else stderrBytes += remaining;
        }
        bytes += Math.max(remaining, 0); reason = "resource_limit"; return;
      }
      (stream === "stdout" ? stdout : stderr).push(chunk);
      if (stream === "stdout") stdoutBytes += chunk.byteLength; else stderrBytes += chunk.byteLength;
      bytes += chunk.byteLength;
    };
    const killAndObserve = async () => {
      if (!command) return;
      await command.kill("SIGKILL");
      await command.wait().catch(() => undefined);
    };
    const cancel = () => { if (!reason) reason = "cancelled"; logAbort.abort(); if (command) termination ??= killAndObserve(); };
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => { if (!reason) reason = "timeout"; logAbort.abort(); if (command) termination ??= killAndObserve(); }, Math.max(1, request.timeoutMs));
    try {
      // Do not pass stdout/stderr: SDK 2.8 starts an unowned log iterator for
      // detached commands when those conveniences are supplied.
      const creating = session.runCommand({ cmd: "sh", args: ["-lc", request.command], cwd: request.cwd, env: {}, detached: true, timeoutMs: request.timeoutMs });
      const abortDuringCreate = new Promise<"aborted">((resolve) => {
        if (request.signal?.aborted) resolve("aborted"); else request.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const first = await Promise.race([creating.then((value) => ({ value })), abortDuringCreate]);
      if (first === "aborted") {
        // A create request may have crossed the provider boundary. Delete the
        // exact random name before returning; if it later resolves, deletion
        // has already removed any possible remote process.
        await this.terminate(workspace).catch(() => undefined);
        void creating.then(async (late) => { await late.kill("SIGKILL").catch(() => undefined); }).catch(() => undefined);
        throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled while creation was in flight", "deferred");
      }
      command = first.value;
      if (reason) termination ??= killAndObserve();
      const iterator = command.logs({ signal: logAbort.signal });
      const consume = (async () => {
        try {
          for await (const log of iterator) {
            append(log.stream, log.data);
            if (reason === "resource_limit") { logAbort.abort(); termination ??= killAndObserve(); await termination; break; }
          }
        } catch (error) { if (!reason) throw error; }
        finally { iterator.close(); }
      })();
      const finished = await command.wait();
      await consume;
      if (reason) { termination ??= killAndObserve(); await termination; throw new CloudWorkspaceError(this.name, reason, reason === "timeout" ? "sandbox command timed out" : reason === "resource_limit" ? "sandbox command output exceeded its byte limit" : "command cancelled", reason === "resource_limit" ? "rejected" : "deferred"); }
      this.assertSession(workspace, sandbox);
      return { exitCode: finished.exitCode, stdout: Buffer.concat(stdout, stdoutBytes), stderr: Buffer.concat(stderr, stderrBytes), durationMs: Date.now() - startedAt };
    } catch (error) {
      if (command) {
        try { await killAndObserve(); }
        catch {
          await this.terminate(workspace).catch(() => undefined);
          throw new CloudWorkspaceError(this.name, "provider_unavailable", "could not prove exact command termination", "blocked");
        }
      }
      if (request.signal?.aborted && !(error instanceof CloudWorkspaceError)) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      throw error;
    } finally {
      clearTimeout(timeout); logAbort.abort(); request.signal?.removeEventListener("abort", cancel);
    }
  }
}

export type CloudflareSandboxCompatibleClient = CloudWorkspaceProvider;

export class CloudflareSandboxCompatibleProvider implements CloudWorkspaceProvider {
  readonly name = "cloudflare" as const;
  readonly capabilities: CloudWorkspaceCapabilities;
  constructor(private readonly client?: CloudflareSandboxCompatibleClient) {
    this.capabilities = client?.capabilities ?? CAPABILITIES.cloudflare;
  }
  private require(): CloudWorkspaceProvider { if (!this.client) throw new CloudWorkspaceError(this.name, "missing_configuration", "Cloudflare Sandbox-compatible client is not configured"); return this.client; }
  createWorkspace: CloudWorkspaceProvider["createWorkspace"] = (input) => this.require().createWorkspace(input);
  uploadCredentiallessArchive: CloudWorkspaceProvider["uploadCredentiallessArchive"] = (workspace, archive) => this.require().uploadCredentiallessArchive(workspace, archive);
  exec: CloudWorkspaceProvider["exec"] = (workspace, request) => this.require().exec(workspace, request);
  readFile: CloudWorkspaceProvider["readFile"] = (workspace, path, maxBytes) => this.require().readFile(workspace, path, maxBytes);
  writeFile: CloudWorkspaceProvider["writeFile"] = (workspace, path, data, maxBytes) => this.require().writeFile(workspace, path, data, maxBytes);
  listFiles: CloudWorkspaceProvider["listFiles"] = (workspace, path, maxEntries) => this.require().listFiles(workspace, path, maxEntries);
  checkpoint: CloudWorkspaceProvider["checkpoint"] = (workspace, input) => this.require().checkpoint(workspace, input);
  recreateFromCheckpoint: CloudWorkspaceProvider["recreateFromCheckpoint"] = (input) => this.require().recreateFromCheckpoint(input);
  exportPatch: CloudWorkspaceProvider["exportPatch"] = (workspace, baseSha, maxBytes) => this.require().exportPatch(workspace, baseSha, maxBytes);
  terminate: CloudWorkspaceProvider["terminate"] = (workspace, reason) => this.require().terminate(workspace, reason);
}

export type CloudWorkspaceCleanupProvider = Readonly<{
  name: CloudWorkspaceProviderName;
  terminate: CloudWorkspaceProvider["terminate"];
}>;

function configuredProviderAdapterForName(
  env: Readonly<Record<string, string | undefined>>,
  name: CloudWorkspaceProviderName,
): CloudWorkspaceProvider {
  if (name === "e2b") {
    if (!env.E2B_API_KEY) throw new CloudWorkspaceError("e2b", "missing_configuration", "E2B_API_KEY is not configured");
    return new E2BCloudWorkspaceProvider(env.E2B_API_KEY);
  }
  if (name === "sandbox0") {
    if (!env.SANDBOX0_TOKEN) throw new CloudWorkspaceError("sandbox0", "missing_configuration", "SANDBOX0_TOKEN is not configured");
    return new Sandbox0CloudWorkspaceProvider(env.SANDBOX0_TOKEN, env.SANDBOX0_BASE_URL);
  }
  if (name === "vercel") {
    if (!env.VERCEL_TOKEN || !env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID) {
      throw new CloudWorkspaceError("vercel", "missing_configuration", "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are all required");
    }
    return new VercelCloudWorkspaceProvider(env.VERCEL_TOKEN, env.VERCEL_TEAM_ID, env.VERCEL_PROJECT_ID);
  }
  if (name === "cloudflare") {
    throw new CloudWorkspaceError("cloudflare", "missing_configuration", "Cloudflare Sandbox-compatible client is not configured");
  }
  throw new CloudWorkspaceError("cloudflare", "invalid_configuration", "unknown persisted cloud workspace provider");
}

function configuredProviderAdapter(env: Readonly<Record<string, string | undefined>>): CloudWorkspaceProvider {
  const name = String(env.JARVIS_CLOUD_WORKSPACE_PROVIDER ?? "").trim().toLowerCase();
  if (!["e2b", "sandbox0", "vercel", "cloudflare"].includes(name)) {
    throw new CloudWorkspaceError("cloudflare", "missing_configuration", "JARVIS_CLOUD_WORKSPACE_PROVIDER must select e2b, sandbox0, vercel, or cloudflare");
  }
  return configuredProviderAdapterForName(env, name as CloudWorkspaceProviderName);
}

export function configuredCloudWorkspaceProvider(
  env: Readonly<Record<string, string | undefined>>,
  runtimeAttestation: CloudProviderRuntimeAttestation,
): CloudWorkspaceProvider {
  assertCloudProviderExecutionReady(env, runtimeAttestation);
  const provider = configuredProviderAdapter(env);
  assertRequiredCapabilities(provider);
  return provider;
}

/** Orphan cleanup never receives execution authority or exposes execution methods. */
export function configuredCloudWorkspaceCleanupProvider(
  env: Readonly<Record<string, string | undefined>>,
  persistedProviderName?: HistoricalCloudWorkspaceProviderName,
): CloudWorkspaceCleanupProvider {
  if (persistedProviderName === "daytona") {
    throw new CloudWorkspaceError(
      "daytona",
      "cleanup_blocked",
      "Historical Daytona workspace cleanup is blocked because the retired provider adapter is not executable; provider-side attention is required",
      "blocked",
    );
  }
  const provider = persistedProviderName
    ? configuredProviderAdapterForName(env, persistedProviderName)
    : configuredProviderAdapter(env);
  return Object.freeze({
    name: provider.name,
    terminate: (workspace, reason) => provider.terminate(workspace, reason),
  });
}

/** Live-probe authority is explicit and never available to normal execution or cleanup callers. */
export function configuredCloudWorkspaceProviderForLiveProbe(
  env: Readonly<Record<string, string | undefined>>,
): CloudWorkspaceProvider {
  const name = String(env.JARVIS_CLOUD_WORKSPACE_PROVIDER ?? "").trim().toLowerCase();
  if (env.JARVIS_CLOUD_PROVIDER_PROBE !== "live") {
    const provider = name === "e2b" || name === "sandbox0" || name === "vercel" || name === "cloudflare" ? name : "cloudflare";
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", "live provider probe authority was not explicitly enabled", "blocked");
  }
  return configuredProviderAdapter(env);
}
