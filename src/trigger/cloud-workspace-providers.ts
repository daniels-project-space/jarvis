import { createHash, randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import type { Sandbox as E2BSandbox } from "e2b";
import type { Client as Sandbox0Client, Sandbox as Sandbox0Sandbox } from "sandbox0";
import type { Command as VercelCommand, Sandbox as VercelSandbox, Session as VercelSession } from "@vercel/sandbox";
import { envvars } from "@trigger.dev/sdk/v3";
import { runWithDeadline } from "../lib/bounded-json";
import { configuredCloudWorkspaceProviderName } from "../lib/cloud-provider-selection";
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
  selfhost: {
    // This describes the pinned runner protocol, not an optimistic local
    // fallback. Construction and the live lifecycle probe both fail closed
    // until an operator supplies an HTTPS endpoint and shared bearer.
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    emptyEnvironment: true, boundedResources: true, boundedTtl: true,
    exactCommandCancellation: true, sameWorkspaceResume: true, portableCheckpointReplay: true,
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

function fencedVercelPaths(workspace: CloudWorkspace): ProviderPaths {
  // The random provider name is never derived from caller-controlled source
  // content. Keeping controller artifacts under it prevents a valid source tar
  // from naming the control area while still keeping every path in-repository.
  if (!/^jarvis-[0-9a-f]{40}$/.test(workspace.providerWorkspaceId)) {
    throw new CloudWorkspaceError("vercel", "stale_attempt", "Vercel Sandbox attempt name is not an owned fenced identity", "deferred");
  }
  const root = workspace.root;
  const controlDir = `${root}/.jarvis-controller-${workspace.providerWorkspaceId}`;
  return {
    root,
    controlDir,
    archivePath: `${controlDir}/source-upload.tar`,
    sourcePath: `${controlDir}/source.tar`,
    checkpointPatchPath: `${controlDir}/checkpoint.patch`,
    replayStage: `${controlDir}/replay-stage`,
    replayPath: `${controlDir}/replay.tar`,
    patchPath: `${controlDir}/output.patch`,
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
    `git add -A -- . ${controllerGitExcludes(paths)}`,
    "git commit -q --allow-empty -m 'credentialless controller baseline'",
    "git update-ref refs/jarvis/controller-base HEAD",
  ].join(" && ");
}

/** Keep the per-attempt controller area out of every repository baseline and
 * patch.  The generic layouts keep it outside the root; Vercel deliberately
 * puts it under the root, so this must be calculated from the exact attempt. */
function controllerGitExcludes(paths: ProviderPaths): string {
  if (!paths.controlDir.startsWith(`${paths.root}/`)) return "";
  const relative = paths.controlDir.slice(paths.root.length + 1);
  return `':(exclude)${relative}' ':(exclude)${relative}/**'`;
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
  const excludes = [...CHECKPOINT_EXCLUDES.map((path) => `':(exclude)${path}' ":(exclude)${path}/**"`), controllerGitExcludes(paths)].filter(Boolean).join(" ");
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
    command: `mkdir -p ${paths.controlDir} && rm -f ${paths.patchPath} && git add -N -- . ${controllerGitExcludes(paths)} && git diff --binary --no-ext-diff refs/jarvis/controller-base -- . ${controllerGitExcludes(paths)} > ${paths.patchPath}`,
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
  /** Providers with a stricter filesystem fence may derive control paths from
   * the attempt identity. The default preserves the legacy provider layout. */
  protected pathsFor(workspace: CloudWorkspace) { void workspace; return this.paths; }
  protected async prepareWorkspace(workspace: CloudWorkspace): Promise<void> { void workspace; }
  protected async cleanupOrBlock(workspace: CloudWorkspace, original: unknown, message: string): Promise<never> {
    try { await this.terminate(workspace, "terminal"); }
    catch { throw new CloudWorkspaceError(this.name, "cleanup_blocked", message, "blocked"); }
    throw original;
  }
  protected resetForReplay(paths: ProviderPaths): string[] {
    return [`rm -rf ${paths.root} ${paths.replayStage}`, `mkdir -p ${paths.root} ${paths.replayStage}`];
  }

  async uploadCredentiallessArchive(workspace: CloudWorkspace, archive: CredentiallessArchive): Promise<void> {
    validateCredentiallessArchive(archive, DEFAULT_WORKSPACE_LIMITS, this.name);
    await this.prepareWorkspace(workspace);
    const paths = this.pathsFor(workspace);
    await this.writeAbsolute(workspace, paths.archivePath, archive.bytes, DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
    const result = await this.exec(workspace, {
      command: hydrateCommand(paths), cwd: workspace.root, timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
      maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes,
    });
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "credentialless archive hydration failed", "deferred");
  }

  async checkpoint(workspace: CloudWorkspace, input: {
    jobId: string; attempt: number; baseSha: string; sourceArchiveSha256: string; sourceArchiveBytes: number;
    runtime: string; lockfileDigest: string; template: string; attemptKey: string; causationId: string;
  }) { return checkpointThroughProvider(this, workspace, (path, maxBytes) => this.readAbsolute(workspace, path, maxBytes), input, this.pathsFor(workspace)); }

  async recreateFromCheckpoint(input: { checkpoint: WorkspaceCheckpoint; archive: Uint8Array; limits: WorkspaceLimits; attemptKey: string }) {
    validatePortableCheckpointArchive(input.archive, input.checkpoint, input.limits);
    const workspace = await this.createWorkspace({
      attemptKey: input.attemptKey,
      template: input.checkpoint.template,
      runtime: input.checkpoint.runtime,
      lockfileDigest: input.checkpoint.lockfileDigest,
      limits: input.limits,
    });
    try {
      await this.prepareWorkspace(workspace);
      const paths = this.pathsFor(workspace);
      await this.writeAbsolute(workspace, paths.replayPath, input.archive, input.limits.maxArchiveBytes);
      const result = await this.exec(workspace, {
      command: [
        ...this.resetForReplay(paths),
        `tar --no-same-owner --no-same-permissions -xf ${paths.replayPath} -C ${paths.replayStage}`,
        `mv ${paths.replayStage}/source.tar ${paths.sourcePath}`,
        `tar --no-same-owner --no-same-permissions -xf ${paths.sourcePath} -C ${paths.root}`,
        `cd ${paths.root}`,
        "git init -q",
        "git config user.email jarvis-controller@example.invalid",
        "git config user.name 'JARVIS controller baseline'",
        `git add -A -- . ${controllerGitExcludes(paths)}`,
        "git commit -q --allow-empty -m 'credentialless controller baseline'",
        "git update-ref refs/jarvis/controller-base HEAD",
        `git apply --whitespace=nowarn ${paths.replayStage}/workspace.patch`,
        `rm -rf ${paths.replayStage} ${paths.replayPath}`,
      ].join(" && "),
      cwd: workspace.root, timeoutMs: input.limits.commandTimeoutMs, maxOutputBytes: input.limits.maxOutputBytes,
      });
      if (result.exitCode !== 0) {
        throw new CloudWorkspaceError(this.name, "provider_unavailable", "portable checkpoint replay failed", "deferred");
      }
      return workspace;
    } catch (error) {
      return await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after checkpoint replay failure");
    }
  }

  async exportPatch(workspace: CloudWorkspace, baseSha: string, maxBytes: number) {
    return exportPatchThroughProvider(this, workspace, (path, limit) => this.readAbsolute(workspace, path, limit), baseSha, maxBytes, this.pathsFor(workspace));
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
/** Jarvis may use at most four of the Hobby account's ten concurrent sessions. */
export const VERCEL_ACTIVE_SANDBOX_CAP = 4;
export const VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE = Object.freeze({
  runtime: "node22",
  vcpus: 2,
  memoryMb: 4_096,
  networkPolicy: "deny-all",
  persistent: false,
  portCount: 0,
  ttlMs: VERCEL_SAFE_TTL_MS,
});
const VERCEL_MAX_LIST_ENTRIES = 10_000;
export const VERCEL_NAME_PREFIX = "jarvis";
export const VERCEL_HISTORY_PAGE_LIMIT = 50;
export const VERCEL_HISTORY_PAGE_CEILING = 8;
export const VERCEL_HISTORY_TOTAL_CEILING = VERCEL_HISTORY_PAGE_LIMIT * VERCEL_HISTORY_PAGE_CEILING;
const VERCEL_LIST_DEADLINE_MS = 30_000;
const VERCEL_CREATE_DEADLINE_MS = 60_000;
const VERCEL_CONTROL_DEADLINE_MS = 30_000;
// Cold Vercel Sessions can take longer than a short shell probe to complete
// their exact-session observation. This remains far below the attempt TTL.
const VERCEL_GUARD_COMMAND_TIMEOUT_MS = 60_000;

type VercelControlDeadlines = Readonly<{
  listMs: number;
  createMs: number;
  controlMs: number;
}>;

function vercelWorkspaceName(attemptKey: string): string {
  // The exact immutable work attempt owns one provider name. A timed-out
  // create can therefore be reconciled without allocating a competitor.
  return `${VERCEL_NAME_PREFIX}-${createHash("sha256").update(attemptKey).digest("hex").slice(0, 40)}`;
}

type VercelTeamBilling = Readonly<{ plan?: unknown; status?: unknown }>;

export function isVercelProSpendApproved(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Proves that the configured Vercel team is active and that paid usage has
 * been deliberately approved. Hobby has no paid overage; Pro remains blocked
 * unless the deployment carries an explicit production approval.
 */
export async function assertVercelPlanAuthorized(
  token: string,
  teamId: string,
  proSpendApproved: boolean,
  signal?: AbortSignal,
): Promise<Readonly<{ teamId: string; plan: "hobby" | "pro"; status: "active" }>> {
  let response: Response;
  try {
    response = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    });
  } catch {
    throw new CloudWorkspaceError("vercel", "provider_unavailable", "Vercel plan observation failed", "deferred");
  }
  if (!response.ok) {
    throw new CloudWorkspaceError("vercel", "provider_unavailable", "Vercel plan observation was unavailable", "deferred");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CloudWorkspaceError("vercel", "provider_unavailable", "Vercel plan response was malformed", "deferred");
  }
  const team = body && typeof body === "object" && !Array.isArray(body)
    ? body as { id?: unknown; billing?: VercelTeamBilling }
    : undefined;
  if (team?.id !== teamId) {
    throw new CloudWorkspaceError("vercel", "invalid_configuration", "Vercel plan observation did not match the configured team", "blocked");
  }
  if (team.billing?.status !== "active" || (team.billing.plan !== "hobby" && team.billing.plan !== "pro")) {
    throw new CloudWorkspaceError(
      "vercel",
      "invalid_configuration",
      "Vercel cloud work requires an active Hobby or Pro plan",
      "blocked",
    );
  }
  if (team.billing.plan === "pro" && !proSpendApproved) {
    throw new CloudWorkspaceError(
      "vercel",
      "invalid_configuration",
      "Vercel Pro sandbox usage requires JARVIS_VERCEL_PRO_SPEND_APPROVED=true",
      "blocked",
    );
  }
  return { teamId, plan: team.billing.plan, status: "active" };
}

function vercelCwd(workspace: CloudWorkspace, cwd: string | undefined): string {
  const value = pathPosix.normalize(cwd ?? workspace.root);
  if (value !== workspace.root && !value.startsWith(`${workspace.root}/`)) {
    throw new CloudWorkspaceError("vercel", "unsafe_archive", "command cwd escapes the workspace root", "rejected");
  }
  return value;
}

function vercelAbsolutePath(workspace: CloudWorkspace, value: string): string {
  const absolute = value.startsWith("/") ? value : safeWorkspacePath(workspace, value);
  const normalized = pathPosix.normalize(absolute);
  if (normalized === workspace.root || normalized.startsWith(`${workspace.root}/`)) return normalized;
  throw new CloudWorkspaceError("vercel", "unsafe_archive", "sandbox path escapes the workspace root", "rejected");
}

function decodeOutput(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new CloudWorkspaceError("vercel", "unsafe_patch", "sandbox emitted invalid UTF-8 output", "rejected"); }
}

/** The command log transport is text, while POSIX names are bytes.  Keep the
 * on-sandbox frame as canonical standard base64 and validate every property
 * before converting an individual name to text. */
export function decodeVercelListing(value: Buffer, maxEntries: number): string[] {
  const encoded = decodeOutput(value);
  if (encoded === "") return [];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new CloudWorkspaceError("vercel", "unsafe_archive", "sandbox listing encoding is malformed or non-canonical", "rejected");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || bytes.length === 0 || bytes[bytes.length - 1] !== 0) {
    throw new CloudWorkspaceError("vercel", "unsafe_archive", "sandbox listing frame is malformed or unterminated", "rejected");
  }
  const names: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    // A NUL is a frame delimiter, never data. Empty fields cover an initial,
    // repeated, or otherwise fabricated terminal delimiter.
    if (index === start) throw new CloudWorkspaceError("vercel", "unsafe_archive", "sandbox listing contains an empty NUL field", "rejected");
    const name = decodeOutput(bytes.subarray(start, index));
    if (validateRelativePath(name, "vercel") !== name) {
      throw new CloudWorkspaceError("vercel", "unsafe_archive", "sandbox listing contains an unsafe entry", "rejected");
    }
    names.push(name);
    if (names.length > maxEntries) throw new CloudWorkspaceError("vercel", "resource_limit", "sandbox listing exceeds limit", "rejected");
    start = index + 1;
  }
  // The terminal NUL must be the sole trailing delimiter; the loop ends with
  // start exactly at the byte length only for a complete canonical frame.
  if (start !== bytes.length) throw new CloudWorkspaceError("vercel", "unsafe_archive", "sandbox listing frame is unterminated", "rejected");
  return names;
}

/**
 * The Sandbox command transport turns stdout into text, but POSIX directory
 * names are bytes.  This is deliberately one Node process rather than a shell
 * sequence: it completes every observation and lstat before it writes the
 * base64 frame, so a later encoder can never hide an earlier safety failure.
 */
const VERCEL_LISTING_PROGRAM = String.raw`
"use strict";
const fs = require("node:fs");
const base = process.argv[1];
const maxEntries = Number(process.argv[2]);
const failure = (exitCode) => { const error = new Error("listing rejected"); error.exitCode = exitCode; throw error; };
try {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) failure(1);
  const resolvedBase = fs.realpathSync.native(base);
  const baseStat = fs.lstatSync(base);
  if (resolvedBase !== base || baseStat.isSymbolicLink() || !baseStat.isDirectory()) failure(43);
  const names = fs.readdirSync(base, { encoding: "buffer" });
  if (names.length > maxEntries) failure(42);
  const baseBytes = Buffer.from(resolvedBase);
  for (const name of names) {
    if (!Buffer.isBuffer(name) || name.length === 0 || name.includes(0) || name.includes(47)) failure(1);
    const child = Buffer.concat([baseBytes, Buffer.from("/"), name]);
    if (fs.lstatSync(child).isSymbolicLink()) failure(43);
  }
  const frame = names.length === 0 ? Buffer.alloc(0) : Buffer.concat(names.flatMap((name) => [name, Buffer.from([0])]));
  process.stdout.write(frame.toString("base64"));
} catch (error) {
  process.exitCode = error && (error.exitCode === 42 || error.exitCode === 43) ? error.exitCode : 1;
}
`;

/** Exported so the behavioral test runs the exact command transported to a
 * Sandbox, rather than a synthetic exit-code hook. */
export function buildVercelListingCommand(base: string, maxEntries: number): string {
  return `node -e ${shellQuote(VERCEL_LISTING_PROGRAM)} -- ${shellQuote(base)} ${maxEntries}`;
}

function boundedUtf8Prefix(value: string, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (Buffer.byteLength(value) <= maxBytes) return Buffer.from(value);
  // Do not copy a provider-controlled giant log chunk just to truncate it.
  // Advance over complete Unicode code points so the retained bytes are valid
  // UTF-8 and at most the caller's cumulative byte budget.
  let chars = 0;
  let bytes = 0;
  for (const codePoint of value) {
    const next = Buffer.byteLength(codePoint);
    if (bytes + next > maxBytes) break;
    bytes += next;
    chars += codePoint.length;
  }
  return Buffer.from(value.slice(0, chars));
}

function assertVercelCommandBounds(timeoutMs: number, maxOutputBytes: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > VERCEL_SAFE_TTL_MS) {
    throw new CloudWorkspaceError("vercel", "resource_limit", "command timeout is outside the bounded Vercel attempt lifetime", "rejected");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > DEFAULT_WORKSPACE_LIMITS.maxOutputBytes) {
    throw new CloudWorkspaceError("vercel", "resource_limit", "command output limit is outside the controller byte bound", "rejected");
  }
}

/** Vercel returns this explicit code when a racing kill reaches an already-terminal command. */
function vercelCommandAlreadyTerminal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const payload = (error as { json?: unknown }).json;
  if (!payload || typeof payload !== "object") return false;
  const detail = (payload as { error?: unknown }).error;
  return Boolean(detail && typeof detail === "object" && (detail as { code?: unknown }).code === "command_not_found_or_exited");
}

function assertVercelFileBound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > DEFAULT_WORKSPACE_LIMITS.maxFileBytes) {
    throw new CloudWorkspaceError("vercel", "resource_limit", "file byte limit is outside the controller bound", "rejected");
  }
}

/** Controller-owned source, checkpoint, and patch artifacts are separately
 * bounded by the archive limit. Public tool reads never use this path. */
function assertVercelArtifactBound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes) {
    throw new CloudWorkspaceError("vercel", "resource_limit", "artifact byte limit is outside the controller archive bound", "rejected");
  }
}

function assertVercelWriteBound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes) {
    throw new CloudWorkspaceError("vercel", "resource_limit", "write byte limit is outside the controller archive bound", "rejected");
  }
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
  return urls.every((url) => {
    try {
      const parsed = new URL(url);
      // `origin` normalizes an explicit default port. Keep the authority
      // check deliberately narrow nonetheless: npm ci must not gain egress
      // to a look-alike host, a credential-bearing URL, or a non-HTTPS URL.
      return parsed.protocol === "https:" && parsed.hostname === "registry.npmjs.org"
        && (parsed.port === "" || parsed.port === "443") && !parsed.username && !parsed.password;
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

  constructor(
    private readonly token: string,
    private readonly teamId: string,
    private readonly projectId: string,
    private readonly deadlines: VercelControlDeadlines = {
      listMs: VERCEL_LIST_DEADLINE_MS,
      createMs: VERCEL_CREATE_DEADLINE_MS,
      controlMs: VERCEL_CONTROL_DEADLINE_MS,
    },
    private readonly proSpendApproved = false,
  ) {
    super();
    if (Object.values(deadlines).some((value) => !Number.isSafeInteger(value) || value < 1 || value > 10 * 60_000)) {
      throw new CloudWorkspaceError("vercel", "invalid_configuration", "Vercel Sandbox control-plane deadlines are invalid", "blocked");
    }
  }

  protected override pathsFor(workspace: CloudWorkspace) { return fencedVercelPaths(workspace); }
  protected override resetForReplay(paths: ProviderPaths): string[] {
    // Do not remove the replay artifact/control directory which is deliberately
    // below the fenced repository root. Only its siblings are source content.
    return [
      `find -P -- ${shellQuote(paths.root)} -mindepth 1 -maxdepth 1 ! -path ${shellQuote(paths.controlDir)} -exec rm -rf -- {} +`,
      `rm -rf -- ${shellQuote(paths.replayStage)}`,
      `mkdir -p -- ${shellQuote(paths.root)} ${shellQuote(paths.replayStage)}`,
    ];
  }
  protected override async prepareWorkspace(workspace: CloudWorkspace): Promise<void> {
    let observed = await this.observeFreshSession(workspace);
    const paths = this.pathsFor(workspace);
    // These are direct session calls: neither can resume a stopped Sandbox.
    // The root is established before it becomes a command cwd, and every
    // subsequent data-plane path is realpath/lstat checked below it.
    await this.controlCall(
      "workspace root creation",
      (signal) => observed.session.mkDir(workspace.root, { signal }),
    );
    observed = await this.observeFreshSession(workspace);
    observed = await this.assertNoSymlink(workspace, observed.sandbox, observed.session, workspace.root, false);
    const result = await this.runSessionCommand(workspace, observed.sandbox, observed.session, {
      command: `mkdir -- ${shellQuote(paths.controlDir)} && [ "$(realpath -e -- ${shellQuote(paths.controlDir)})" = ${shellQuote(paths.controlDir)} ] && [ ! -L ${shellQuote(paths.controlDir)} ]`,
      cwd: workspace.root, timeoutMs: VERCEL_GUARD_COMMAND_TIMEOUT_MS, maxOutputBytes: 4_000,
    });
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "unsafe_archive", "could not establish a fenced sandbox control directory", "rejected");
    await this.observeFreshSession(workspace);
  }

  private credentials() { return { token: this.token, teamId: this.teamId, projectId: this.projectId }; }

  private providerFailure(operation: string, error: unknown): CloudWorkspaceError {
    if (error instanceof CloudWorkspaceError) return error;
    const message = String((error as Error | undefined)?.message ?? error);
    if (/(?:not[_ -]?found|404|already deleted)/i.test(message)) {
      return new CloudWorkspaceError(this.name, "stale_attempt", "Vercel Sandbox named attempt is absent", "deferred");
    }
    const timedOut = /operation deadline exceeded|aborterror|aborted/i.test(message);
    return new CloudWorkspaceError(
      this.name,
      timedOut ? "timeout" : "provider_unavailable",
      `Vercel Sandbox ${operation} ${timedOut ? "exceeded its controller deadline" : "failed"}`,
      "deferred",
    );
  }

  private async controlCall<T>(
    operation: string,
    call: (signal: AbortSignal) => Promise<T>,
    timeoutMs = this.deadlines.controlMs,
  ): Promise<T> {
    try {
      return await runWithDeadline(timeoutMs, call);
    } catch (error) {
      throw this.providerFailure(operation, error);
    }
  }

  private async cleanupExactName(
    Sandbox: typeof import("@vercel/sandbox").Sandbox,
    name: string,
  ): Promise<boolean> {
    let sandbox: VercelSandbox;
    try {
      sandbox = await this.controlCall(
        "uncertain-create observation",
        (signal) => Sandbox.get({ ...this.credentials(), name, resume: false, signal }),
      );
    } catch (error) {
      if (this.absent(error)) return false;
      throw new CloudWorkspaceError(this.name, "cleanup_blocked", "could not reconcile the exact timed-out sandbox name", "blocked");
    }
    try {
      await this.controlCall("uncertain-create cleanup", (signal) => sandbox.delete({ signal }));
      return true;
    } catch {
      throw new CloudWorkspaceError(this.name, "cleanup_blocked", "could not delete the exact timed-out sandbox attempt", "blocked");
    }
  }

  private workspaceFromSandbox(sandbox: VercelSandbox): CloudWorkspace {
    const session = sandbox.currentSession();
    if (session.status !== "running" || sandbox.routes.length || sandbox.runtime !== "node22" || sandbox.vcpus !== 2 || sandbox.memory !== 4096
      || sandbox.networkPolicy !== "deny-all" || session.networkPolicy !== "deny-all") {
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "Vercel Sandbox creation did not preserve private bounded deny-all configuration", "blocked");
    }
    const workspace = {
      provider: this.name,
      providerWorkspaceId: sandbox.name,
      providerSessionId: session.sessionId,
      root: this.workspaceRoot,
      createdAt: Date.now(),
    } satisfies CloudWorkspace;
    assertWorkspaceIdentity(workspace);
    return workspace;
  }

  async createWorkspace(input: Parameters<CloudWorkspaceProvider["createWorkspace"]>[0]) {
    if (![this.token, this.teamId, this.projectId].every((value) => value.trim().length > 0)) {
      throw new CloudWorkspaceError(this.name, "missing_configuration", "Vercel Sandbox requires controller token, team, and project identifiers", "blocked");
    }
    if (!Number.isSafeInteger(input.limits.ttlMs) || input.limits.ttlMs < 1) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "Vercel Sandbox attempt TTL must be a positive safe integer", "rejected");
    }
    await this.controlCall(
      "plan authorization observation",
      (signal) => assertVercelPlanAuthorized(this.token, this.teamId, this.proSpendApproved, signal),
    );
    const { Sandbox } = await import("@vercel/sandbox");
    const exactName = vercelWorkspaceName(input.attemptKey);
    let active = 0;
    let pages = 0;
    let total = 0;
    let complete = false;
    let exact: { name: string; status: string } | undefined;
    await input.onStage?.("provider_list");
    try {
      await runWithDeadline(this.deadlines.listMs, async (signal) => {
        const listed = await Sandbox.list({
          ...this.credentials(),
          namePrefix: VERCEL_NAME_PREFIX,
          sortBy: "name",
          sortOrder: "asc",
          tags: { owner: "jarvis" },
          limit: VERCEL_HISTORY_PAGE_LIMIT,
          signal,
        });
        // Page metadata proves the complete project-scoped active count under
        // one abort deadline and the hard history ceiling.
        for await (const page of listed.pages()) {
          pages += 1;
          total += page.sandboxes.length;
          if (pages > VERCEL_HISTORY_PAGE_CEILING || total > VERCEL_HISTORY_TOTAL_CEILING) {
            throw new CloudWorkspaceError(this.name, "resource_limit", "Vercel Sandbox history exceeds the bounded controller enumeration ceiling", "deferred");
          }
          for (const item of page.sandboxes) {
            if (item.name === exactName) exact = item;
            if (["pending", "running", "snapshotting", "stopping"].includes(item.status)) active += 1;
          }
          if (page.pagination.next === null) {
            complete = true;
            break;
          }
          if (pages === VERCEL_HISTORY_PAGE_CEILING) {
            throw new CloudWorkspaceError(this.name, "resource_limit", "Vercel Sandbox history completeness cannot be proved within the controller page ceiling", "deferred");
          }
        }
      });
    } catch (error) {
      throw this.providerFailure("bounded history enumeration", error);
    }
    // A paginator which simply stops while advertising another cursor is not
    // proof that active attempts were fully counted. Creation is allowed only
    // after observing the terminal page metadata itself.
    if (!complete) {
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "Vercel Sandbox history paginator ended before its advertised terminal page", "deferred");
    }
    if (exact) {
      if (exact.status === "running") {
        const reconciled = await this.controlCall(
          "exact attempt reconciliation",
          (signal) => Sandbox.get({ ...this.credentials(), name: exactName, resume: false, signal }),
        );
        try {
          return this.workspaceFromSandbox(reconciled);
        } catch (error) {
          await this.cleanupExactName(Sandbox, exactName);
          throw error;
        }
      }
      await this.cleanupExactName(Sandbox, exactName);
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "prior exact sandbox attempt was reconciled; retry creation after durable requeue", "deferred");
    }
    if (active >= VERCEL_ACTIVE_SANDBOX_CAP) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "Vercel Sandbox controller active-attempt cap is reached", "deferred");
    }
    await input.onStage?.("provider_create");
    let sandbox: VercelSandbox;
    try {
      sandbox = await this.controlCall(
        "creation",
        (signal) => Sandbox.create({
          ...this.credentials(),
          name: exactName,
          runtime: VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.runtime,
          // Deliberately no source, ports, or authority-shaped environment.
          env: {}, ports: [], networkPolicy: VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.networkPolicy,
          resources: { vcpus: VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.vcpus },
          timeout: Math.min(input.limits.ttlMs, VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.ttlMs),
          persistent: VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.persistent,
          tags: {
            owner: "jarvis",
            attempt: createHash("sha256").update(input.attemptKey).digest("hex").slice(0, 32),
            runtime: VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.runtime,
          },
          signal,
        }),
        this.deadlines.createMs,
      );
    } catch (error) {
      await this.cleanupExactName(Sandbox, exactName);
      throw this.providerFailure("creation", error);
    }
    try {
      return this.workspaceFromSandbox(sandbox);
    } catch (error) {
      try { await this.controlCall("misconfigured-attempt cleanup", (signal) => sandbox.delete({ signal })); }
      catch { throw new CloudWorkspaceError(this.name, "cleanup_blocked", "could not delete the exact misconfigured sandbox attempt", "blocked"); }
      throw error;
    }
  }

  override async uploadCredentiallessArchive(workspace: CloudWorkspace, archive: CredentiallessArchive): Promise<void> {
    // The controller normally performs the same cleanup, but source upload is
    // itself an agent boundary. Keep this adapter independently fail-closed so
    // a direct caller cannot leave a session with partially hydrated source.
    try {
      await super.uploadCredentiallessArchive(workspace, archive);
    } catch (error) {
      await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after source upload failure");
    }
  }

  override async checkpoint(workspace: CloudWorkspace, input: Parameters<CloudWorkspaceProvider["checkpoint"]>[1]) {
    try { return await super.checkpoint(workspace, input); }
    catch (error) { return await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after checkpoint failure"); }
  }

  override async exportPatch(workspace: CloudWorkspace, baseSha: string, maxBytes: number) {
    try { return await super.exportPatch(workspace, baseSha, maxBytes); }
    catch (error) { return await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after patch export failure"); }
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

  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number) {
    assertVercelFileBound(maxBytes);
    return this.readAbsolute(workspace, safeWorkspacePath(workspace, path), maxBytes);
  }
  protected async readAbsolute(workspace: CloudWorkspace, path: string, maxBytes: number) {
    assertVercelArtifactBound(maxBytes);
    let observed = await this.observeFreshSession(workspace);
    const absolute = vercelAbsolutePath(workspace, path);
    observed = await this.assertNoSymlink(workspace, observed.sandbox, observed.session, absolute, false);
    // Never read through the pre-lstat Session snapshot. The lstat command is
    // itself a substitution boundary and returns this freshly observed one.
    // One deadline owns both stream acquisition and complete iteration. The
    // explicit abort listener also closes a stream whose iterator ignores its
    // SDK signal, so a stalled body cannot outlive the controller boundary.
    const bytes = await this.controlCall("sandbox file read", async (signal) => {
      let stream: (NodeJS.ReadableStream & { destroy?: () => void; close?: () => void }) | null = null;
      const destroy = () => {
        if (stream?.destroy) stream.destroy();
        else stream?.close?.();
      };
      try {
        stream = await observed.session.readFile({ path: absolute }, { signal });
        if (!stream) throw new CloudWorkspaceError(this.name, "provider_unavailable", "sandbox file is missing", "deferred");
        if (signal.aborted) {
          destroy();
          throw new DOMException("sandbox file read aborted", "AbortError");
        }
        signal.addEventListener("abort", destroy, { once: true });
        const chunks: Buffer[] = [];
        let used = 0;
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (chunk.byteLength > maxBytes - used) {
            throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected");
          }
          chunks.push(chunk);
          used += chunk.byteLength;
        }
        return new Uint8Array(Buffer.concat(chunks, used));
      } finally {
        signal.removeEventListener("abort", destroy);
        destroy();
      }
    });
    await this.observeFreshSession(workspace);
    return bytes;
  }
  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { return this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes); }
  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) {
    assertVercelWriteBound(maxBytes);
    if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected");
    let observed = await this.observeFreshSession(workspace);
    const absolute = vercelAbsolutePath(workspace, path);
    observed = await this.assertNoSymlink(workspace, observed.sandbox, observed.session, absolute, true);
    try {
      // The write must use the Session returned by the realpath observation.
      await this.controlCall(
        "sandbox file write",
        (signal) => observed.session.writeFiles([{ path: absolute, content: data }], { signal }),
      );
      await this.observeFreshSession(workspace);
    } catch (error) {
      if (error instanceof CloudWorkspaceError && error.code === "stale_attempt") {
        await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after a substituted file write");
      }
      throw error;
    }
  }
  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > VERCEL_MAX_LIST_ENTRIES) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing limit is invalid", "rejected");
    let observed = await this.observeFreshSession(workspace);
    const base = vercelAbsolutePath(workspace, path);
    observed = await this.assertNoSymlink(workspace, observed.sandbox, observed.session, base, false);
    const command = buildVercelListingCommand(base, maxEntries);
    const result = await this.runSessionCommand(workspace, observed.sandbox, observed.session, { command, cwd: workspace.root, timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs, maxOutputBytes: Math.max(1_024, Math.min(DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, maxEntries * 512)) });
    if (result.exitCode === 42) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected");
    if (result.exitCode === 43) throw new CloudWorkspaceError(this.name, "unsafe_archive", "symlink encountered during bounded listing", "rejected");
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "sandbox file listing failed", "deferred");
    const names = decodeVercelListing(result.stdout, maxEntries);
    await this.observeFreshSession(workspace); return names;
  }

  async hydrateDependencies(workspace: CloudWorkspace): Promise<void> {
    // Source has already been validated and uploaded. This parses only the
    // committed lockfile, opens one registry for one command, then relocks.
    try {
      let observed = await this.observeFreshSession(workspace);
      try {
        const lockPath = `${this.workspaceRoot}/package-lock.json`;
        const paths = this.pathsFor(workspace);
        const cachePath = `${paths.controlDir}/npm-cache`;
        const controlRelative = paths.controlDir.slice(this.workspaceRoot.length + 1);
        // Exclude both the control directory itself and its descendants. Git
        // clean otherwise removes the untracked directory as a whole before
        // its descendant exclusions can preserve controller artifacts.
        const controlCleanExcludes = `-e ${shellQuote(controlRelative)} -e ${shellQuote(`${controlRelative}/`)} -e ${shellQuote(`${controlRelative}/**`)}`;
        // A missing lock means no egress. It still proceeds through the
        // tracked deny-all update and behavioral probe below; an early return
        // here could accidentally make a future policy regression invisible.
        observed = await this.assertNoSymlink(workspace, observed.sandbox, observed.session, lockPath, true);
        const exists = await this.runSessionCommand(workspace, observed.sandbox, observed.session, { command: `test -f ${shellQuote(lockPath)}`, cwd: this.workspaceRoot, timeoutMs: VERCEL_GUARD_COMMAND_TIMEOUT_MS, maxOutputBytes: 4_000 });
        if (exists.exitCode !== 1) {
          if (exists.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "could not inspect committed package lock", "deferred");
          // The source working tree must be byte-for-byte the controller base
          // before its lock is parsed. This makes the streamed read below an
          // observation of refs/jarvis/controller-base, not a mutable file a
          // prior sandbox action could have substituted.
          observed = await this.observeFreshSession(workspace);
          const committed = await this.runSessionCommand(workspace, observed.sandbox, observed.session, {
            command: "git ls-files --error-unmatch -- package-lock.json >/dev/null && git diff --quiet refs/jarvis/controller-base -- package-lock.json && git diff --cached --quiet refs/jarvis/controller-base -- package-lock.json",
            cwd: this.workspaceRoot, timeoutMs: VERCEL_GUARD_COMMAND_TIMEOUT_MS, maxOutputBytes: 4_000,
          });
          if (committed.exitCode !== 0) throw new CloudWorkspaceError(this.name, "unsafe_archive", "package lock is not the committed controller baseline", "rejected");
          const lock = await this.readAbsolute(workspace, lockPath, DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
          if (!packageLockUsesOnlyNpmRegistry(lock)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "package lock contains a non-npm-registry dependency", "rejected");
          // Do not invoke update on the snapshot which preceded the lock read.
          // A fresh no-resume observation is the policy-transition capability.
          await this.transitionNetworkPolicy(workspace, VERCEL_NPM_POLICY);
          observed = await this.observeFreshSession(workspace);
          const installed = await this.runSessionCommand(workspace, observed.sandbox, observed.session, {
            command: [
              `npm ci --ignore-scripts --no-audit --no-fund --cache ${shellQuote(cachePath)}`,
              "git reset --hard refs/jarvis/controller-base",
              // `-X` is deliberately forbidden: a valid repository can
              // ignore dot-directories, which would make it delete our
              // controller-owned source archive before checkpointing.
              // npm ci is scriptless and writes only node_modules plus the
              // fenced cache, so reset plus ordinary untracked cleanup is the
              // bounded cleanup required here.
              `git clean -ffd -e node_modules ${controlCleanExcludes}`,
              `rm -rf -- ${shellQuote(cachePath)}`,
            ].join(" && "),
            cwd: this.workspaceRoot, timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs, maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes,
          });
          if (installed.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "deterministic dependency hydration failed", "deferred");
        }
      } finally {
        await this.transitionNetworkPolicy(workspace, "deny-all");
      }
      const relocked = await this.assertFreshSession(workspace);
      if (relocked.networkPolicy !== "deny-all") throw new CloudWorkspaceError(this.name, "provider_unavailable", "dependency hydration did not relock deny-all egress", "blocked");
      const denied = await this.exec(workspace, { command: "node -e 'fetch(\"https://example.com\",{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(9),()=>process.exit(0))'", cwd: this.workspaceRoot, timeoutMs: 8_000, maxOutputBytes: 4_000 });
      if (denied.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "deny-all network verification failed after dependency hydration", "blocked");
    } catch (error) {
      await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after dependency hydration failure");
    }
  }

  async terminate(workspace: CloudWorkspace, reason: "terminal" | "orphan" | "cancelled" = "terminal") {
    void reason;
    // Termination is authorized only for the random, attempt-owned name. It
    // deliberately does not read or resume a session, so a stopped/replaced
    // session cannot make cleanup start compute or skip deletion.
    this.pathsFor(workspace);
    try {
      const sandbox = await this.get(workspace);
      // Cleanup owns only the immutable exact-attempt name. It must never start a
      // session, and a substituted/stopped session cannot block deletion.
      await this.controlCall("sandbox deletion", (signal) => sandbox.delete({ signal }));
    } catch (error) {
      if ((error instanceof CloudWorkspaceError && error.code === "stale_attempt") || this.absent(error)) return;
      throw error;
    } finally { /* deletion is name-scoped; no session cache is retained */ }
  }

  private absent(error: unknown): boolean {
    return (error instanceof CloudWorkspaceError && error.code === "stale_attempt")
      || /(?:not[_ -]?found|404|already deleted)/i.test(String(error));
  }
  protected override async cleanupOrBlock(workspace: CloudWorkspace, original: unknown, message: string): Promise<never> {
    try { await this.terminate(workspace, "terminal"); }
    catch { throw new CloudWorkspaceError(this.name, "cleanup_blocked", message, "blocked"); }
    throw original;
  }
  private async get(workspace: CloudWorkspace): Promise<VercelSandbox> {
    assertWorkspaceIdentity(workspace);
    this.pathsFor(workspace);
    const { Sandbox } = await import("@vercel/sandbox");
    // Never trust a stale SDK object here. This is a control-plane read with
    // resume:false, followed by a fence on its freshly observed Session.
    try {
      return await this.controlCall(
        "sandbox observation",
        (signal) => Sandbox.get({ ...this.credentials(), name: workspace.providerWorkspaceId, resume: false, signal }),
      );
    } catch (error) {
      // A missing named attempt is not an invitation to create or resume one.
      // Classify it exactly like a stopped or substituted session before any
      // data-plane action can be attempted.
      if (this.absent(error)) {
        throw new CloudWorkspaceError(this.name, "stale_attempt", "Vercel Sandbox attempt is missing for this session fence", "deferred");
      }
      throw error;
    }
  }
  private assertSession(workspace: CloudWorkspace, sandbox: VercelSandbox) {
    const session = sandbox.currentSession();
    if (session.sessionId !== workspace.providerSessionId || session.status !== "running") {
      throw new CloudWorkspaceError(this.name, "stale_attempt", "Vercel Sandbox session changed or stopped for this attempt", "deferred");
    }
    return session;
  }

  /**
   * A Session object is a snapshot. Re-reading the named sandbox without
   * resume is the only post-operation identity check that can observe a
   * provider-side stop or replacement; inspecting the object used for the
   * data-plane call again would merely repeat stale local metadata.
   */
  private async assertFreshSession(workspace: CloudWorkspace): Promise<VercelSession> {
    return this.assertSession(workspace, await this.get(workspace));
  }

  private async observeFreshSession(workspace: CloudWorkspace): Promise<{ sandbox: VercelSandbox; session: VercelSession }> {
    const sandbox = await this.get(workspace);
    return { sandbox, session: this.assertSession(workspace, sandbox) };
  }

  private async transitionNetworkPolicy(workspace: CloudWorkspace, networkPolicy: "deny-all" | typeof VERCEL_NPM_POLICY): Promise<{ sandbox: VercelSandbox; session: VercelSession }> {
    const observed = await this.observeFreshSession(workspace);
    await this.controlCall(
      "sandbox network policy update",
      (signal) => observed.session.update({ networkPolicy }, { signal }),
    );
    // update is a provider-side transition, so preserve a fresh post-boundary
    // observation rather than trusting the object that submitted it.
    return this.observeFreshSession(workspace);
  }

  private async assertNoSymlink(workspace: CloudWorkspace, sandbox: VercelSandbox, session: VercelSession, path: string, writing: boolean): Promise<{ sandbox: VercelSandbox; session: VercelSession }> {
    if (path !== workspace.root && !path.startsWith(`${workspace.root}/`)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "sandbox path escapes the workspace root", "rejected");
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const check = writing
      ? `[ "$(realpath -e -- ${shellQuote(parent)})" = ${shellQuote(parent)} ] && { [ ! -e ${shellQuote(path)} ] || [ ! -L ${shellQuote(path)} ]; }`
      : `[ "$(realpath -e -- ${shellQuote(path)})" = ${shellQuote(path)} ] && [ ! -L ${shellQuote(path)} ]`;
    const result = await this.runSessionCommand(workspace, sandbox, session, { command: check, cwd: workspace.root, timeoutMs: VERCEL_GUARD_COMMAND_TIMEOUT_MS, maxOutputBytes: 4_000 });
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "unsafe_archive", "sandbox path is missing, symlinked, or escapes the workspace root", "rejected");
    return this.observeFreshSession(workspace);
  }

  /** A lexical prefix is never a cwd fence. Re-observe the exact named
   * Session, then ask that fresh Session to resolve every path component
   * before the caller's command is created. */
  private async assertSafeCommandCwd(workspace: CloudWorkspace, cwd: string): Promise<{ sandbox: VercelSandbox; session: VercelSession }> {
    const sandbox = await this.get(workspace);
    const session = this.assertSession(workspace, sandbox);
    // The fence is a provider command too.  It must not be allowed to retain
    // an unowned wait if a provider stalls it, so run it through the same
    // single wait/kill/iterator lifecycle as caller commands.  `skipCwdFence`
    // is safe only here: this exact fresh Session is establishing the fence.
    const observed = await this.runSessionCommand(workspace, sandbox, session, {
      command: `[ "$(realpath -e -- ${shellQuote(cwd)})" = ${shellQuote(cwd)} ] && [ ! -L ${shellQuote(cwd)} ]`,
      cwd: workspace.root, timeoutMs: VERCEL_GUARD_COMMAND_TIMEOUT_MS, maxOutputBytes: 4_000,
    }, true);
    if (observed.exitCode !== 0) throw new CloudWorkspaceError(this.name, "unsafe_archive", "command cwd is missing, symlinked, or escapes the workspace root", "rejected");
    const freshSandbox = await this.get(workspace);
    return { sandbox: freshSandbox, session: this.assertSession(workspace, freshSandbox) };
  }

  private async runSessionCommand(
    workspace: CloudWorkspace, sandbox: VercelSandbox, session: VercelSession,
    request: { command: string; cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
    skipCwdFence = false,
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; durationMs: number }> {
    assertVercelCommandBounds(request.timeoutMs, request.maxOutputBytes);
    if (!skipCwdFence) ({ sandbox, session } = await this.assertSafeCommandCwd(workspace, request.cwd));
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    const startedAt = Date.now();
    let command: VercelCommand | undefined;
    let waitPromise: Promise<{ exitCode: number }> | undefined;
    let logPromise: Promise<void> | undefined;
    let reason: "cancelled" | "timeout" | "resource_limit" | undefined;
    let termination: Promise<void> | undefined;
    let closeLogs: (() => Promise<void>) | undefined;
    const closeLogsSafely = () => { void closeLogs?.().catch(() => undefined); };
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let stdoutBytes = 0; let stderrBytes = 0;
    const append = (stream: "stdout" | "stderr", data: string) => {
      const chunkBytes = Buffer.byteLength(data); const remaining = request.maxOutputBytes - bytes;
      if (chunkBytes > remaining) {
        if (remaining > 0) {
          const prefix = boundedUtf8Prefix(data, remaining);
          (stream === "stdout" ? stdout : stderr).push(prefix);
          if (stream === "stdout") stdoutBytes += prefix.byteLength; else stderrBytes += prefix.byteLength;
        }
        bytes += Math.max(remaining, 0); reason = "resource_limit"; return;
      }
      const chunk = Buffer.from(data);
      (stream === "stdout" ? stdout : stderr).push(chunk);
      if (stream === "stdout") stdoutBytes += chunk.byteLength; else stderrBytes += chunk.byteLength;
      bytes += chunk.byteLength;
    };
    const killAndObserve = (): Promise<void> => {
      if (!command || !waitPromise) return Promise.resolve();
      termination ??= (async () => {
        try { await command!.kill("SIGKILL"); }
        catch (error) {
          // A terminal response cannot leave this exact command running. Its
          // owned wait remains mandatory before the cancellation is reported.
          if (!vercelCommandAlreadyTerminal(error)) throw error;
        }
        await waitPromise!;
      })();
      return termination;
    };
    let interruptCreation: (() => void) | undefined;
    const creationInterrupted = new Promise<"interrupted">((resolve) => { interruptCreation = () => resolve("interrupted"); });
    const cancel = () => {
      if (!reason) reason = "cancelled";
      closeLogsSafely();
      interruptCreation?.();
      if (command) termination = killAndObserve();
    };
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      if (!reason) reason = "timeout";
      closeLogsSafely();
      interruptCreation?.();
      if (command) termination = killAndObserve();
    }, Math.max(1, request.timeoutMs));
    try {
      // Do not pass stdout/stderr: SDK 2.8 starts an unowned log iterator for
      // detached commands when those conveniences are supplied.
      this.assertSession(workspace, sandbox);
      // Stay on the already-attested exact Session: Sandbox.runCommand may
      // auto-resume a stopped workspace, while Session.runCommand preserves
      // the no-resume fence. The v3 SDK still receives cancellation directly.
      const creating = session.runCommand({
        cmd: "sh", args: ["-lc", request.command], cwd: request.cwd, env: {},
        detached: true, timeoutMs: request.timeoutMs, signal: request.signal,
      });
      const first = await Promise.race([creating.then((value) => ({ value })), creationInterrupted]);
      if (first === "interrupted") {
        // A create request may have crossed the provider boundary. Delete the
        // exact random name before returning; if it later resolves, deletion
        // has already removed any possible remote process.
        try { await this.terminate(workspace, "cancelled"); }
        catch { throw new CloudWorkspaceError(this.name, "cleanup_blocked", "could not delete the exact sandbox after interrupted command creation", "blocked"); }
        // Creation can settle after cancellation. Own its one wait and one
        // kill/observe chain so it cannot become an unobserved remote process.
        void creating.then(async (late) => {
          const lateWait = late.wait();
          try { await late.kill("SIGKILL"); await lateWait; } catch { /* exact attempt was already deleted above */ }
        }).catch(() => undefined);
        if (reason === "timeout") {
          throw new CloudWorkspaceError(this.name, "timeout", "sandbox command timed out while creation was in flight", "deferred");
        }
        throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled while creation was in flight", "deferred");
      }
      command = first.value;
      waitPromise = command.wait();
      // Command creation is a provider-side session-substitution boundary.
      // Do not consume logs or regard a created command as authoritative until
      // the exact name has been re-read with resume:false and its Session is
      // still the identity recorded in the workspace.
      ({ sandbox, session } = await this.observeFreshSession(workspace));
      if (reason) {
        termination = killAndObserve();
        await termination;
        if (reason === "timeout") throw new CloudWorkspaceError(this.name, "timeout", "sandbox command timed out", "deferred");
        if (reason === "resource_limit") throw new CloudWorkspaceError(this.name, "resource_limit", "sandbox command output exceeded its byte limit", "rejected");
        throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      }
      // The SDK's merged external log signal can self-abort while a command
      // is completing. Own the iterator's close method instead; it closes the
      // exact stream on every terminal path without sharing abort state.
      const iterator = command.logs();
      let closePromise: Promise<void> | undefined;
      closeLogs = () => closePromise ??= Promise.resolve()
        .then(() => iterator.close())
        .then(() => undefined);
      logPromise = (async () => {
        try {
          for await (const log of iterator) {
            append(log.stream, log.data);
            if (reason === "resource_limit") { closeLogsSafely(); termination = killAndObserve(); await termination; break; }
          }
        } catch (error) { throw error; }
        finally { await closeLogs(); closeLogs = undefined; }
      })();
      const raced = await Promise.race([
        waitPromise.then((value) => ({ kind: "wait" as const, value })),
        logPromise.then(() => ({ kind: "logs" as const }), (error) => Promise.reject(error)),
      ]);
      if (raced.kind === "logs") await waitPromise;
      else await logPromise;
      const finished = raced.kind === "wait" ? raced.value : await waitPromise;
      if (reason) { termination = killAndObserve(); await termination; throw new CloudWorkspaceError(this.name, reason, reason === "timeout" ? "sandbox command timed out" : reason === "resource_limit" ? "sandbox command output exceeded its byte limit" : "command cancelled", reason === "resource_limit" ? "rejected" : "deferred"); }
      await this.assertFreshSession(workspace);
      return { exitCode: finished.exitCode, stdout: Buffer.concat(stdout, stdoutBytes), stderr: Buffer.concat(stderr, stderrBytes), durationMs: Date.now() - startedAt };
    } catch (error) {
      if (command) {
        closeLogsSafely();
        try {
          await logPromise?.catch(() => undefined);
          await killAndObserve();
          // A failed fresh observation after command creation means the
          // command belonged to an uncertain/substituted provider session.
          // It has one wait promise and one kill; now exact-name deletion is
          // mandatory so no later command or Codex boundary can be reached.
          if (error instanceof CloudWorkspaceError && error.code === "stale_attempt") {
            await this.terminate(workspace, "terminal");
          }
        }
        catch {
          await this.cleanupOrBlock(workspace, error, "could not delete the exact sandbox after uncertain command termination");
        }
      }
      if (reason === "timeout" && !(error instanceof CloudWorkspaceError)) {
        throw new CloudWorkspaceError(this.name, "timeout", "sandbox command timed out", "deferred");
      }
      if (reason === "resource_limit" && !(error instanceof CloudWorkspaceError)) {
        throw new CloudWorkspaceError(this.name, "resource_limit", "sandbox command output exceeded its byte limit", "rejected");
      }
      if (reason === "cancelled" && !(error instanceof CloudWorkspaceError)) {
        throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      }
      if (request.signal?.aborted && !(error instanceof CloudWorkspaceError)) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      throw error;
    } finally {
      clearTimeout(timeout); interruptCreation = undefined; closeLogsSafely(); request.signal?.removeEventListener("abort", cancel);
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

/**
 * Versioned, vendored protocol for a Daniel-controlled runner. It deliberately
 * has no discovery path: the caller must name an HTTPS endpoint and present a
 * high-entropy bearer before this adapter can make a single network request.
 * The server contract lives in docs/self-hosted-runner.md.
 */
export const SELF_HOSTED_RUNNER_PROTOCOL_VERSION = "1.0.0";
const SELF_HOSTED_RUNNER_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const SELF_HOSTED_RUNNER_ID = /^[A-Za-z0-9._:-]{1,240}$/;
const SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS = 20_000;
const SELF_HOSTED_RUNNER_MAX_JSON_BYTES = 2 * 1024 * 1024;

type SelfHostedRunnerFetch = typeof fetch;

function selfHostedRunnerRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudWorkspaceError("selfhost", "invalid_configuration", message, "blocked");
  }
  return value as Record<string, unknown>;
}

function selfHostedRunnerId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SELF_HOSTED_RUNNER_ID.test(normalized)) {
    throw new CloudWorkspaceError("selfhost", "invalid_configuration", `self-hosted runner ${label} is malformed`, "blocked");
  }
  return normalized;
}

function selfHostedRunnerNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CloudWorkspaceError("selfhost", "invalid_configuration", `self-hosted runner ${label} is malformed`, "blocked");
  }
  return Number(value);
}

function selfHostedRunnerEndpoint(raw: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(raw); }
  catch { throw new CloudWorkspaceError("selfhost", "missing_configuration", "JARVIS_SELF_HOST_RUNNER_URL must be an HTTPS URL", "blocked"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new CloudWorkspaceError("selfhost", "missing_configuration", "JARVIS_SELF_HOST_RUNNER_URL must be a credential-free HTTPS URL", "blocked");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/`;
  return endpoint;
}

/** A concrete REST transport, not a local fallback or a simulated sandbox. */
export class SelfHostedRunnerCloudWorkspaceProvider extends ProviderBase {
  readonly name = "selfhost" as const;
  readonly capabilities = CAPABILITIES.selfhost;
  // Self-hosted dependency hydration is intentionally not supported. The
  // runner starts deny-by-default and executes only its credentialless archive.
  declare readonly hydrateDependencies?: CloudWorkspaceProvider["hydrateDependencies"];
  private readonly endpoint: URL;

  constructor(
    rawEndpoint: string,
    private readonly token: string,
    private readonly request: SelfHostedRunnerFetch = fetch,
  ) {
    super();
    this.endpoint = selfHostedRunnerEndpoint(rawEndpoint.trim());
    if (!SELF_HOSTED_RUNNER_TOKEN.test(token)) {
      throw new CloudWorkspaceError(this.name, "missing_configuration", "JARVIS_SELF_HOST_RUNNER_TOKEN must be a 32+ character base64url bearer", "blocked");
    }
  }

  private api(path: string, query: Record<string, string | number> = {}): URL {
    const url = new URL(path.replace(/^\/+/, ""), this.endpoint);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url;
  }

  private workspacePath(workspace: CloudWorkspace, suffix: string): string {
    this.assertWorkspace(workspace);
    return `v1/workspaces/${encodeURIComponent(workspace.providerWorkspaceId)}${suffix}`;
  }

  private filePath(workspace: CloudWorkspace, path: string, max: number): string {
    const route = this.workspacePath(workspace, "/files");
    return `${route}?path=${encodeURIComponent(path)}&max=${encodeURIComponent(String(max))}`;
  }

  private assertWorkspace(workspace: CloudWorkspace): void {
    if (workspace.provider !== this.name) {
      throw new CloudWorkspaceError(this.name, "invalid_configuration", "self-hosted runner received a foreign workspace identity", "blocked");
    }
    assertWorkspaceIdentity(workspace);
  }

  private async response(
    method: string,
    path: string,
    options: { body?: BodyInit; headers?: HeadersInit; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> {
    const deadline = AbortSignal.timeout(Math.min(60_000, Math.max(1_000, options.timeoutMs ?? SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS)));
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const response = await this.request(this.api(path), {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-jarvis-self-hosted-runner-protocol": SELF_HOSTED_RUNNER_PROTOCOL_VERSION,
          ...options.headers,
        },
        body: options.body,
        signal,
        // A redirect could forward the bearer to a different origin.
        redirect: "error",
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new CloudWorkspaceError(this.name, "missing_configuration", "self-hosted runner authentication was rejected", "blocked");
        }
        throw new CloudWorkspaceError(this.name, "provider_unavailable", "self-hosted runner request was rejected", "deferred");
      }
      return response;
    } catch (error) {
      if (error instanceof CloudWorkspaceError) throw error;
      if (options.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "self-hosted runner command cancelled", "deferred");
      if (deadline.aborted) throw new CloudWorkspaceError(this.name, "timeout", "self-hosted runner request timed out", "deferred");
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "self-hosted runner is unavailable", "deferred");
    }
  }

  private async json(
    method: string,
    path: string,
    options: { value?: unknown; headers?: HeadersInit; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.response(method, path, {
      ...(options.value === undefined ? {} : {
        body: JSON.stringify(options.value),
        headers: { ...options.headers, "content-type": "application/json" },
      }),
      ...(options.value === undefined && options.headers ? { headers: options.headers } : {}),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    const size = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(size) && size > SELF_HOSTED_RUNNER_MAX_JSON_BYTES) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "self-hosted runner control response exceeds its limit", "rejected");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > SELF_HOSTED_RUNNER_MAX_JSON_BYTES) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "self-hosted runner control response exceeds its limit", "rejected");
    }
    try { return selfHostedRunnerRecord(JSON.parse(text), "control response is malformed"); }
    catch (error) {
      if (error instanceof CloudWorkspaceError) throw error;
      throw new CloudWorkspaceError(this.name, "invalid_configuration", "self-hosted runner control response is malformed", "blocked");
    }
  }

  private async bytes(
    method: string,
    path: string,
    maxBytes: number,
    options: { body?: BodyInit; headers?: HeadersInit; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Uint8Array> {
    const response = await this.response(method, path, options);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "self-hosted runner file exceeds its limit", "rejected");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "self-hosted runner file exceeds its limit", "rejected");
    }
    return bytes;
  }

  async createWorkspace(input: Parameters<CloudWorkspaceProvider["createWorkspace"]>[0]): Promise<CloudWorkspace> {
    const created = await this.json("POST", "v1/workspaces", {
      value: {
        attemptKey: input.attemptKey,
        template: input.template,
        runtime: input.runtime,
        lockfileDigest: input.lockfileDigest,
        limits: input.limits,
      },
    });
    const providerWorkspaceId = selfHostedRunnerId(created.workspaceId, "workspace identity");
    const providerSessionId = selfHostedRunnerId(created.sessionId, "session identity");
    if (providerWorkspaceId === providerSessionId || created.root !== this.workspaceRoot) {
      throw new CloudWorkspaceError(this.name, "invalid_configuration", "self-hosted runner returned an invalid workspace boundary", "blocked");
    }
    const workspace = {
      provider: this.name,
      providerWorkspaceId,
      providerSessionId,
      root: this.workspaceRoot,
      createdAt: selfHostedRunnerNumber(created.createdAt, "creation time"),
    } satisfies CloudWorkspace;
    assertWorkspaceIdentity(workspace);
    return workspace;
  }

  async exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult> {
    this.assertWorkspace(workspace);
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "self-hosted runner command cancelled", "deferred");
    const cwd = request.cwd ?? workspace.root;
    if (cwd !== workspace.root) {
      throw new CloudWorkspaceError(this.name, "invalid_configuration", "self-hosted runner command cwd escaped the workspace root", "blocked");
    }
    const result = await this.json("POST", this.workspacePath(workspace, "/exec"), {
      value: {
        sessionId: workspace.providerSessionId,
        command: request.command,
        cwd,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      },
      signal: request.signal,
      timeoutMs: request.timeoutMs + 1_000,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (!Number.isSafeInteger(result.exitCode)
      || Buffer.byteLength(stdout) > request.maxOutputBytes
      || Buffer.byteLength(stderr) > request.maxOutputBytes
      || selfHostedRunnerId(result.sessionId, "command session") !== workspace.providerSessionId) {
      throw new CloudWorkspaceError(this.name, "invalid_configuration", "self-hosted runner command response is invalid", "blocked");
    }
    return {
      exitCode: Number(result.exitCode),
      stdout,
      stderr,
      providerSessionId: workspace.providerSessionId,
      durationMs: selfHostedRunnerNumber(result.durationMs, "command duration"),
    };
  }

  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number): Promise<Uint8Array> {
    return await this.readAbsolute(workspace, safeWorkspacePath(workspace, path), maxBytes);
  }

  protected async readAbsolute(workspace: CloudWorkspace, path: string, maxBytes: number): Promise<Uint8Array> {
    return await this.bytes("GET", this.filePath(workspace, path, maxBytes), maxBytes, {
      headers: {
        accept: "application/octet-stream",
        "x-jarvis-workspace-session": workspace.providerSessionId,
      },
      timeoutMs: SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS,
    });
  }

  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number): Promise<void> {
    await this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes);
  }

  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number): Promise<void> {
    if (data.byteLength > maxBytes) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "self-hosted runner write exceeds its limit", "rejected");
    }
    await this.response("PUT", this.workspacePath(workspace, "/files"), {
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      headers: {
        "content-type": "application/octet-stream",
        "x-jarvis-workspace-session": workspace.providerSessionId,
        "x-jarvis-workspace-path": path,
        "x-jarvis-max-bytes": String(maxBytes),
      },
      timeoutMs: SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS,
    });
  }

  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number): Promise<string[]> {
    const result = await this.json("GET", this.filePath(workspace, safeWorkspacePath(workspace, path), maxEntries), {
      // The path is read-only but still must be bound to the exact session.
      // Otherwise a recycled workspace id could disclose another attempt.
      headers: {
        accept: "application/json",
        "x-jarvis-workspace-session": workspace.providerSessionId,
      },
      timeoutMs: SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS,
    });
    if (!Array.isArray(result.entries) || result.entries.length > maxEntries) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "self-hosted runner file listing exceeds its limit", "rejected");
    }
    return result.entries.map((entry) => {
      if (typeof entry !== "string" || !entry || entry.length > 2_048) {
        throw new CloudWorkspaceError(this.name, "invalid_configuration", "self-hosted runner file listing is malformed", "blocked");
      }
      return validateRelativePath(entry, this.name);
    });
  }

  /** Re-observed by the live probe before receipt issuance; never trusted alone. */
  async observeWorkspace(workspace: CloudWorkspace): Promise<{ ttlMs: number; observedMemory: number }> {
    const result = await this.json("GET", this.workspacePath(workspace, "/attestation"), {
      headers: { "x-jarvis-workspace-session": workspace.providerSessionId },
      timeoutMs: SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS,
    });
    const limits = selfHostedRunnerRecord(result.limits, "workspace limits are malformed");
    const security = selfHostedRunnerRecord(result.security, "workspace security proof is malformed");
    const quota = selfHostedRunnerRecord(result.quota, "workspace quota proof is malformed");
    if (result.protocolVersion !== SELF_HOSTED_RUNNER_PROTOCOL_VERSION
      || selfHostedRunnerId(result.workspaceId, "attestation workspace identity") !== workspace.providerWorkspaceId
      || selfHostedRunnerId(result.sessionId, "attestation session identity") !== workspace.providerSessionId
      || result.state !== "running"
      || selfHostedRunnerNumber(limits.cpu, "CPU limit") < 1
      || selfHostedRunnerNumber(limits.cpu, "CPU limit") > DEFAULT_WORKSPACE_LIMITS.cpu
      || selfHostedRunnerNumber(limits.memoryMb, "memory limit") < 1
      || selfHostedRunnerNumber(limits.memoryMb, "memory limit") > DEFAULT_WORKSPACE_LIMITS.memoryMb
      || selfHostedRunnerNumber(limits.ttlMs, "TTL limit") < 1
      || selfHostedRunnerNumber(limits.ttlMs, "TTL limit") > DEFAULT_WORKSPACE_LIMITS.ttlMs
      || selfHostedRunnerNumber(quota.maxActiveWorkspaces, "active workspace quota") < 1
      || selfHostedRunnerNumber(quota.activeWorkspaces, "active workspace count") > selfHostedRunnerNumber(quota.maxActiveWorkspaces, "active workspace quota")
      || ["credentiallessArchive", "privateIngress", "networkDenyByDefault", "emptyEnvironment", "boundedResources", "boundedTtl", "exactCommandCancellation", "portableCheckpointReplay"].some((key) => security[key] !== true)) {
      throw new CloudWorkspaceError(this.name, "provider_probe_attestation_failed", "self-hosted runner workspace policy proof was rejected", "blocked");
    }
    return { ttlMs: Number(limits.ttlMs), observedMemory: Number(limits.memoryMb) };
  }

  async terminate(workspace: CloudWorkspace, reason: "terminal" | "orphan" | "cancelled"): Promise<void> {
    await this.response("DELETE", this.workspacePath(workspace, ""), {
      body: JSON.stringify({ sessionId: workspace.providerSessionId, reason }),
      headers: { "content-type": "application/json" },
      timeoutMs: SELF_HOSTED_RUNNER_CONTROL_TIMEOUT_MS,
    });
  }
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
    return new VercelCloudWorkspaceProvider(
      env.VERCEL_TOKEN,
      env.VERCEL_TEAM_ID,
      env.VERCEL_PROJECT_ID,
      undefined,
      isVercelProSpendApproved(env.JARVIS_VERCEL_PRO_SPEND_APPROVED),
    );
  }
  if (name === "selfhost") {
    return new SelfHostedRunnerCloudWorkspaceProvider(
      String(env.JARVIS_SELF_HOST_RUNNER_URL ?? ""),
      String(env.JARVIS_SELF_HOST_RUNNER_TOKEN ?? ""),
    );
  }
  if (name === "cloudflare") {
    throw new CloudWorkspaceError("cloudflare", "missing_configuration", "Cloudflare Sandbox-compatible client is not configured");
  }
  throw new CloudWorkspaceError("cloudflare", "invalid_configuration", "unknown persisted cloud workspace provider");
}

function configuredProviderAdapter(env: Readonly<Record<string, string | undefined>>): CloudWorkspaceProvider {
  const name = configuredCloudWorkspaceProviderName(env);
  if (!name) {
    throw new CloudWorkspaceError("cloudflare", "missing_configuration", "No complete managed cloud workspace configuration is available");
  }
  return configuredProviderAdapterForName(env, name);
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

const RUNTIME_PROOF_VARIABLES = [
  "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID",
  "JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT",
] as const;

type RuntimeProofEnvironment = Readonly<Record<(typeof RUNTIME_PROOF_VARIABLES)[number], string | undefined>>;
type RuntimeProofLoader = () => Promise<RuntimeProofEnvironment>;

function runtimeProofUnavailable(
  env: Readonly<Record<string, string | undefined>>,
): never {
  throw new CloudWorkspaceError(
    configuredCloudWorkspaceProviderName(env) ?? "cloudflare",
    "provider_probe_attestation_failed",
    "current Trigger cloud provider proof is unavailable or secret-redacted",
    "blocked",
  );
}

/**
 * The receipt is generated only after Trigger assigns ctx.deployment.version.
 * Read the two mutable proof fields from Trigger's control plane at task start
 * so a proof for the executing version does not require another deployment.
 */
async function currentTriggerRuntimeProof(): Promise<RuntimeProofEnvironment> {
  try {
    const variables = await Promise.all(RUNTIME_PROOF_VARIABLES.map(async (name) => {
      const value = await envvars.retrieve(name);
      if (value.name !== name || value.isSecret || typeof value.value !== "string") throw new Error("unavailable");
      return [name, value.value] as const;
    }));
    return Object.fromEntries(variables) as RuntimeProofEnvironment;
  } catch {
    // The caller maps all management-plane failures to one safe, typed hold.
    return {
      JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID: undefined,
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: undefined,
    };
  }
}

export async function configuredCloudWorkspaceProviderForCurrentTriggerDeployment(
  env: Readonly<Record<string, string | undefined>>,
  runtimeAttestation: CloudProviderRuntimeAttestation,
  loadRuntimeProof: RuntimeProofLoader = currentTriggerRuntimeProof,
): Promise<CloudWorkspaceProvider> {
  let runtimeProof: RuntimeProofEnvironment;
  try {
    runtimeProof = await loadRuntimeProof();
  } catch {
    return runtimeProofUnavailable(env);
  }
  if (!runtimeProof.JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID || !runtimeProof.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT) {
    return runtimeProofUnavailable(env);
  }
  // Never fall back to a build-time copy.  It necessarily names the previous
  // Trigger deployment after a new version has been created.
  return configuredCloudWorkspaceProvider({ ...env, ...runtimeProof }, runtimeAttestation);
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
    const provider = name === "e2b" || name === "sandbox0" || name === "vercel" || name === "selfhost" || name === "cloudflare" ? name : "cloudflare";
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", "live provider probe authority was not explicitly enabled", "blocked");
  }
  return configuredProviderAdapter(env);
}
