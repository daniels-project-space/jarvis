import { randomUUID } from "node:crypto";
import type { Sandbox as E2BSandbox } from "e2b";
import type { Daytona, Sandbox as DaytonaSandbox } from "@daytona/sdk";
import type { Client as Sandbox0Client, Sandbox as Sandbox0Sandbox } from "sandbox0";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  assertRequiredCapabilities,
  assertWorkspaceIdentity,
  sha256Bytes,
  validateCredentiallessArchive,
  validatePatchManifest,
  validateRelativePath,
  type CloudWorkspace,
  type CloudWorkspaceCapabilities,
  type CloudWorkspaceProvider,
  type CloudWorkspaceProviderName,
  type CredentiallessArchive,
  type ExecRequest,
  type ExecResult,
  type PatchManifest,
  type WorkspaceCheckpoint,
  type WorkspaceLimits,
} from "./cloud-workspace";
import { assertCloudProviderExecutionReady } from "./cloud-provider-probe-attestation";

const ROOT = "/workspace/repository";
const ARCHIVE_PATH = "/workspace/jarvis-source.tar";
const CHECKPOINT_PATH = `${ROOT}/.git/jarvis-checkpoint.tar`;
const REPLAY_PATH = "/workspace/jarvis-replay.tar";
const PATCH_PATH = `${ROOT}/.git/jarvis-output.patch`;

const CAPABILITIES: Record<CloudWorkspaceProviderName, CloudWorkspaceCapabilities> = {
  e2b: {
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    emptyEnvironment: true, boundedResources: false, boundedTtl: true,
    exactCommandCancellation: true, sameWorkspaceResume: true, portableCheckpointReplay: true,
    providerSnapshots: true, persistentVolumes: true, opaqueSecretProjection: false,
  },
  daytona: {
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    // Snapshot-based create in SDK 0.200.0 has no per-sandbox resources
    // parameter, and deleting a process session is not an exact command kill.
    emptyEnvironment: true, boundedResources: false, boundedTtl: true,
    exactCommandCancellation: false, sameWorkspaceResume: true, portableCheckpointReplay: true,
    providerSnapshots: true, persistentVolumes: true, opaqueSecretProjection: true,
  },
  sandbox0: {
    credentiallessArchive: true, privateIngress: true, networkDenyByDefault: true,
    emptyEnvironment: true, boundedResources: true, boundedTtl: true,
    exactCommandCancellation: true, sameWorkspaceResume: true, portableCheckpointReplay: true,
    providerSnapshots: true, persistentVolumes: true, opaqueSecretProjection: true,
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

function hydrateCommand(): string {
  return [
    `mkdir -p ${ROOT}`,
    `tar --no-same-owner --no-same-permissions -xf ${ARCHIVE_PATH} -C ${ROOT}`,
    `rm -f ${ARCHIVE_PATH}`,
    `cd ${ROOT}`,
    "git init -q",
    "git config user.email jarvis-controller@example.invalid",
    "git config user.name 'JARVIS controller baseline'",
    "git add -A",
    "git commit -q --allow-empty -m 'credentialless controller baseline'",
  ].join(" && ");
}

async function checkpointThroughProvider(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
  input: {
    baseSha: string; runtime: string; lockfileDigest: string; template: string; attemptKey: string; causationId: string;
  },
): Promise<{ manifest: WorkspaceCheckpoint; archive: Uint8Array }> {
  const result = await provider.exec(workspace, {
    command: `tar --format=posix -cf ${CHECKPOINT_PATH} -C ${ROOT} .`,
    cwd: ROOT,
    timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
    maxOutputBytes: 16_384,
  });
  if (result.exitCode !== 0) throw new CloudWorkspaceError(provider.name, "provider_unavailable", "portable checkpoint export failed", "deferred");
  const archive = await provider.readFile(workspace, ".git/jarvis-checkpoint.tar", DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
  const manifest: WorkspaceCheckpoint = {
    version: 1,
    provider: provider.name,
    providerWorkspaceId: workspace.providerWorkspaceId,
    providerSessionId: workspace.providerSessionId,
    baseSha: input.baseSha,
    archiveSha256: sha256Bytes(archive),
    archiveBytes: archive.byteLength,
    runtime: input.runtime,
    lockfileDigest: input.lockfileDigest,
    template: input.template,
    attemptKey: input.attemptKey,
    causationId: input.causationId,
    createdAt: Date.now(),
  };
  return { manifest, archive };
}

async function exportPatchThroughProvider(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
  baseSha: string,
  maxBytes: number,
): Promise<PatchManifest> {
  const result = await provider.exec(workspace, {
    command: `git add -N . && git diff --binary --no-ext-diff HEAD > ${PATCH_PATH}`,
    cwd: ROOT,
    timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
    maxOutputBytes: 16_384,
  });
  if (result.exitCode !== 0) throw new CloudWorkspaceError(provider.name, "provider_unavailable", "patch export failed", "deferred");
  const patch = await provider.readFile(workspace, ".git/jarvis-output.patch", maxBytes);
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

  async uploadCredentiallessArchive(workspace: CloudWorkspace, archive: CredentiallessArchive): Promise<void> {
    validateCredentiallessArchive(archive, DEFAULT_WORKSPACE_LIMITS, this.name);
    await this.writeAbsolute(workspace, ARCHIVE_PATH, archive.bytes, DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
    const result = await this.exec(workspace, {
      command: hydrateCommand(), cwd: "/workspace", timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
      maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes,
    });
    if (result.exitCode !== 0) throw new CloudWorkspaceError(this.name, "provider_unavailable", "credentialless archive hydration failed", "deferred");
  }

  async checkpoint(workspace: CloudWorkspace, input: {
    baseSha: string; runtime: string; lockfileDigest: string; template: string; attemptKey: string; causationId: string;
  }) { return checkpointThroughProvider(this, workspace, input); }

  async recreateFromCheckpoint(input: { checkpoint: WorkspaceCheckpoint; archive: Uint8Array; limits: WorkspaceLimits }) {
    if (sha256Bytes(input.archive) !== input.checkpoint.archiveSha256 || input.archive.byteLength !== input.checkpoint.archiveBytes) {
      throw new CloudWorkspaceError(this.name, "digest_mismatch", "portable checkpoint bytes do not match the manifest", "rejected");
    }
    const workspace = await this.createWorkspace({
      attemptKey: input.checkpoint.attemptKey,
      template: input.checkpoint.template,
      runtime: input.checkpoint.runtime,
      lockfileDigest: input.checkpoint.lockfileDigest,
      limits: input.limits,
    });
    await this.writeAbsolute(workspace, REPLAY_PATH, input.archive, input.limits.maxArchiveBytes);
    const result = await this.exec(workspace, {
      command: `mkdir -p ${ROOT} && tar --no-same-owner --no-same-permissions -xf ${REPLAY_PATH} -C ${ROOT} && rm -f ${REPLAY_PATH}`,
      cwd: "/workspace", timeoutMs: input.limits.commandTimeoutMs, maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      await this.terminate(workspace, "terminal").catch(() => undefined);
      throw new CloudWorkspaceError(this.name, "provider_unavailable", "portable checkpoint replay failed", "deferred");
    }
    return workspace;
  }

  async exportPatch(workspace: CloudWorkspace, baseSha: string, maxBytes: number) {
    return exportPatchThroughProvider(this, workspace, baseSha, maxBytes);
  }

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
      providerSessionId: `e2b-session-${randomUUID()}`, root: ROOT, createdAt: Date.now(),
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
    const bytes = await (await this.get(workspace)).files.read(safeWorkspacePath(workspace, path), { format: "bytes" });
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

class DaytonaCloudWorkspaceProvider extends ProviderBase {
  readonly name = "daytona" as const;
  readonly capabilities = CAPABILITIES.daytona;
  private client?: Daytona;
  private readonly sandboxes = new Map<string, DaytonaSandbox>();
  constructor(private readonly apiKey: string, private readonly apiUrl?: string) { super(); }

  async createWorkspace(input: { attemptKey: string; template: string; runtime: string; lockfileDigest: string; limits: WorkspaceLimits }) {
    if (!this.apiKey) throw new CloudWorkspaceError(this.name, "missing_configuration", "DAYTONA_API_KEY is not configured");
    const client = await this.getClient();
    const sandbox = await client.create({
      snapshot: input.template || undefined,
      envVars: {}, public: false, networkBlockAll: true,
      autoStopInterval: 10, autoArchiveInterval: 60, autoDeleteInterval: 120,
      ttlMinutes: Math.max(1, Math.ceil(input.limits.ttlMs / 60_000)),
      labels: { owner: "jarvis", attempt: input.attemptKey.slice(0, 80), lockfile: input.lockfileDigest.slice(0, 64) },
    });
    const sessionId = `jarvis-${randomUUID()}`;
    await sandbox.process.createSession(sessionId);
    const workspace = { provider: this.name, providerWorkspaceId: sandbox.id, providerSessionId: sessionId, root: ROOT, createdAt: Date.now() } satisfies CloudWorkspace;
    assertWorkspaceIdentity(workspace);
    this.sandboxes.set(sandbox.id, sandbox);
    return workspace;
  }
  async exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult> {
    const sandbox = await this.get(workspace);
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    const command = `cd ${shellQuote(request.cwd ?? workspace.root)} && ${request.command}`;
    const startedAt = Date.now();
    const pending = await sandbox.process.executeSessionCommand(workspace.providerSessionId, {
      command, runAsync: true, suppressInputEcho: true,
    }, Math.max(1, Math.ceil(request.timeoutMs / 1000)));
    const commandId = String(pending.cmdId ?? "");
    if (!commandId) throw new CloudWorkspaceError(this.name, "provider_unavailable", "Daytona did not return a command id", "deferred");
    const abort = () => { void sandbox.process.deleteSession(workspace.providerSessionId); };
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      const deadline = Date.now() + request.timeoutMs;
      let exitCode: number | undefined;
      while (exitCode === undefined && Date.now() < deadline && !request.signal?.aborted) {
        const status = await sandbox.process.getSessionCommand(workspace.providerSessionId, commandId);
        exitCode = status.exitCode ?? undefined;
        if (exitCode === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
      if (exitCode === undefined) { await sandbox.process.deleteSession(workspace.providerSessionId); throw new CloudWorkspaceError(this.name, "timeout", "command timed out", "deferred"); }
      const logs = await sandbox.process.getSessionCommandLogs(workspace.providerSessionId, commandId);
      const stdout = outputLimit(String(logs.stdout ?? logs.output ?? ""), request.maxOutputBytes, this.name);
      const stderr = outputLimit(String(logs.stderr ?? ""), request.maxOutputBytes, this.name);
      return { exitCode, stdout, stderr, providerSessionId: workspace.providerSessionId, durationMs: Date.now() - startedAt };
    } finally { request.signal?.removeEventListener("abort", abort); }
  }
  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number) {
    const bytes = new Uint8Array(await (await this.get(workspace)).fs.downloadFile(safeWorkspacePath(workspace, path), Math.ceil(DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs / 1000)));
    if (bytes.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected");
    return bytes;
  }
  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { return this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes); }
  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) {
    if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected");
    await (await this.get(workspace)).fs.uploadFile(Buffer.from(data), path, Math.ceil(DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs / 1000));
  }
  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number) {
    const entries = await (await this.get(workspace)).fs.listFiles(safeWorkspacePath(workspace, path), { depth: 1 });
    if (entries.length > maxEntries) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected");
    return entries.map((entry) => String(entry.path));
  }
  async terminate(workspace: CloudWorkspace) { const sandbox = await this.get(workspace); await (await this.getClient()).delete(sandbox, 60, true); this.sandboxes.delete(workspace.providerWorkspaceId); }
  private async getClient() { if (!this.client) { const { Daytona } = await import("@daytona/sdk"); this.client = new Daytona({ apiKey: this.apiKey, apiUrl: this.apiUrl, otelEnabled: false }); } return this.client; }
  private async get(workspace: CloudWorkspace) { assertWorkspaceIdentity(workspace); const cached = this.sandboxes.get(workspace.providerWorkspaceId); if (cached) return cached; const sandbox = await (await this.getClient()).get(workspace.providerWorkspaceId); this.sandboxes.set(workspace.providerWorkspaceId, sandbox); return sandbox; }
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
    const workspace = { provider: this.name, providerWorkspaceId: sandbox.id, providerSessionId: `sandbox0-context-${randomUUID()}`, root: ROOT, createdAt: Date.now() } satisfies CloudWorkspace;
    assertWorkspaceIdentity(workspace);
    this.sandboxes.set(sandbox.id, sandbox);
    return workspace;
  }
  async exec(workspace: CloudWorkspace, request: ExecRequest): Promise<ExecResult> {
    const sandbox = await this.get(workspace);
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    const startedAt = Date.now();
    const stream = await sandbox.cmdStream(request.command, {
      cwd: request.cwd ?? workspace.root, envVars: {}, wait: true,
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
  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number) { const bytes = await (await this.get(workspace)).readFile(safeWorkspacePath(workspace, path)); if (bytes.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected"); return bytes; }
  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { return this.writeAbsolute(workspace, safeWorkspacePath(workspace, path), data, maxBytes); }
  protected async writeAbsolute(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number) { if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected"); await (await this.get(workspace)).writeFile(path, data); }
  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number) { const entries = await (await this.get(workspace)).listFiles(safeWorkspacePath(workspace, path)); if (entries.length > maxEntries) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected"); if (entries.some((entry) => entry.isLink)) throw new CloudWorkspaceError(this.name, "unsafe_archive", "symlink encountered during bounded listing", "rejected"); return entries.map((entry) => String(entry.path ?? entry.name ?? "")); }
  async terminate(workspace: CloudWorkspace) { await (await this.getClient()).sandboxes.delete(workspace.providerWorkspaceId); this.sandboxes.delete(workspace.providerWorkspaceId); }
  private async getClient() { if (!this.client) { const { Client } = await import("sandbox0"); this.client = new Client({ token: this.token, baseUrl: this.baseUrl }); } return this.client; }
  private async get(workspace: CloudWorkspace) { assertWorkspaceIdentity(workspace); const cached = this.sandboxes.get(workspace.providerWorkspaceId); if (cached) return cached; const sandbox = (await this.getClient()).sandbox(workspace.providerWorkspaceId); this.sandboxes.set(workspace.providerWorkspaceId, sandbox); return sandbox; }
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

class CleanupOnlyCloudWorkspaceProvider implements CloudWorkspaceProvider {
  readonly name: CloudWorkspaceProviderName;
  readonly capabilities = CAPABILITIES.cloudflare;
  constructor(private readonly provider: CloudWorkspaceProvider) { this.name = provider.name; }
  private denied(): never {
    throw new CloudWorkspaceError(this.name, "provider_probe_attestation_failed", "cleanup authority cannot start or operate a cloud workspace", "blocked");
  }
  createWorkspace: CloudWorkspaceProvider["createWorkspace"] = async () => this.denied();
  uploadCredentiallessArchive: CloudWorkspaceProvider["uploadCredentiallessArchive"] = async () => this.denied();
  exec: CloudWorkspaceProvider["exec"] = async () => this.denied();
  readFile: CloudWorkspaceProvider["readFile"] = async () => this.denied();
  writeFile: CloudWorkspaceProvider["writeFile"] = async () => this.denied();
  listFiles: CloudWorkspaceProvider["listFiles"] = async () => this.denied();
  checkpoint: CloudWorkspaceProvider["checkpoint"] = async () => this.denied();
  recreateFromCheckpoint: CloudWorkspaceProvider["recreateFromCheckpoint"] = async () => this.denied();
  exportPatch: CloudWorkspaceProvider["exportPatch"] = async () => this.denied();
  terminate: CloudWorkspaceProvider["terminate"] = (workspace, reason) => this.provider.terminate(workspace, reason);
}

function configuredProviderAdapter(env: Readonly<Record<string, string | undefined>>): CloudWorkspaceProvider {
  const name = String(env.JARVIS_CLOUD_WORKSPACE_PROVIDER ?? "").trim().toLowerCase();
  if (name === "e2b") {
    if (!env.E2B_API_KEY) throw new CloudWorkspaceError("e2b", "missing_configuration", "E2B_API_KEY is not configured");
    return new E2BCloudWorkspaceProvider(env.E2B_API_KEY);
  }
  if (name === "daytona") {
    if (!env.DAYTONA_API_KEY) throw new CloudWorkspaceError("daytona", "missing_configuration", "DAYTONA_API_KEY is not configured");
    return new DaytonaCloudWorkspaceProvider(env.DAYTONA_API_KEY, env.DAYTONA_API_URL);
  }
  if (name === "sandbox0") {
    if (!env.SANDBOX0_TOKEN) throw new CloudWorkspaceError("sandbox0", "missing_configuration", "SANDBOX0_TOKEN is not configured");
    return new Sandbox0CloudWorkspaceProvider(env.SANDBOX0_TOKEN, env.SANDBOX0_BASE_URL);
  }
  if (name === "cloudflare") {
    throw new CloudWorkspaceError("cloudflare", "missing_configuration", "Cloudflare Sandbox-compatible client is not configured");
  }
  throw new CloudWorkspaceError("cloudflare", "missing_configuration", "JARVIS_CLOUD_WORKSPACE_PROVIDER must select e2b, daytona, sandbox0, or cloudflare");
}

export function configuredCloudWorkspaceProvider(
  env: Readonly<Record<string, string | undefined>>,
  requireExecutionCapabilities = true,
): CloudWorkspaceProvider {
  const name = String(env.JARVIS_CLOUD_WORKSPACE_PROVIDER ?? "").trim().toLowerCase();
  if (name === "e2b") {
    if (!env.E2B_API_KEY) throw new CloudWorkspaceError("e2b", "missing_configuration", "E2B_API_KEY is not configured");
  } else if (name === "daytona") {
    if (!env.DAYTONA_API_KEY) throw new CloudWorkspaceError("daytona", "missing_configuration", "DAYTONA_API_KEY is not configured");
  } else if (name === "sandbox0") {
    if (!env.SANDBOX0_TOKEN) throw new CloudWorkspaceError("sandbox0", "missing_configuration", "SANDBOX0_TOKEN is not configured");
  }
  else if (name === "cloudflare") {
    throw new CloudWorkspaceError("cloudflare", "missing_configuration", "Cloudflare Sandbox-compatible client is not configured");
  }
  else throw new CloudWorkspaceError("cloudflare", "missing_configuration", "JARVIS_CLOUD_WORKSPACE_PROVIDER must select e2b, daytona, sandbox0, or cloudflare");
  if (requireExecutionCapabilities) assertCloudProviderExecutionReady(env);
  const provider = configuredProviderAdapter(env);
  if (!requireExecutionCapabilities) return new CleanupOnlyCloudWorkspaceProvider(provider);
  assertRequiredCapabilities(provider);
  return provider;
}

/** Live-probe authority is explicit and never available to normal execution or cleanup callers. */
export function configuredCloudWorkspaceProviderForLiveProbe(
  env: Readonly<Record<string, string | undefined>>,
): CloudWorkspaceProvider {
  const name = String(env.JARVIS_CLOUD_WORKSPACE_PROVIDER ?? "").trim().toLowerCase();
  if (env.JARVIS_CLOUD_PROVIDER_PROBE !== "live") {
    const provider = name === "e2b" || name === "daytona" || name === "sandbox0" || name === "cloudflare" ? name : "cloudflare";
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", "live provider probe authority was not explicitly enabled", "blocked");
  }
  return configuredProviderAdapter(env);
}
