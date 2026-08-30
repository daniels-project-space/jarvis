import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  assertWorkspaceIdentity,
  createPortableCheckpointArchive,
  sha256Bytes,
  validateCredentiallessArchive,
  validateRelativePath,
  validatePortableCheckpointArchive,
  type CloudWorkspace,
  type CloudWorkspaceCapabilities,
  type CloudWorkspaceProvider,
  type CredentiallessArchive,
  type ExecRequest,
  type PatchManifest,
  type WorkspaceCheckpoint,
  type WorkspaceLimits,
} from "./cloud-workspace";

type FakeState = {
  workspace: CloudWorkspace;
  archive?: CredentiallessArchive;
  files: Map<string, Uint8Array>;
  terminated: boolean;
  patch: Uint8Array;
};

export class FakeCloudWorkspaceProvider implements CloudWorkspaceProvider {
  readonly name = "cloudflare" as const;
  readonly capabilities: CloudWorkspaceCapabilities = {
    credentiallessArchive: true,
    privateIngress: true,
    networkDenyByDefault: true,
    emptyEnvironment: true,
    boundedResources: true,
    boundedTtl: true,
    exactCommandCancellation: true,
    sameWorkspaceResume: true,
    portableCheckpointReplay: true,
    providerSnapshots: true,
    persistentVolumes: true,
    opaqueSecretProjection: false,
  };
  readonly calls: string[] = [];
  readonly observedExecEnvironments: Array<Record<string, string>> = [];
  readonly observedExecCommands: string[] = [];
  private readonly states = new Map<string, FakeState>();
  private serial = 0;

  async createWorkspace(input: {
    attemptKey: string;
    template: string;
    runtime: string;
    lockfileDigest: string;
    limits: WorkspaceLimits;
  }): Promise<CloudWorkspace> {
    this.calls.push("createWorkspace");
    if (input.limits.ttlMs <= 0) throw new CloudWorkspaceError(this.name, "resource_limit", "TTL is required");
    const serial = ++this.serial;
    const workspace: CloudWorkspace = {
      provider: this.name,
      providerWorkspaceId: `fake-workspace-${serial}`,
      providerSessionId: `fake-session-${serial}`,
      root: "/workspace/repository",
      createdAt: Date.now(),
    };
    assertWorkspaceIdentity(workspace);
    this.states.set(workspace.providerWorkspaceId, {
      workspace,
      files: new Map(),
      terminated: false,
      patch: new Uint8Array(),
    });
    return workspace;
  }

  async uploadCredentiallessArchive(workspace: CloudWorkspace, archive: CredentiallessArchive): Promise<void> {
    this.calls.push("uploadCredentiallessArchive");
    validateCredentiallessArchive(archive, DEFAULT_WORKSPACE_LIMITS, this.name);
    this.state(workspace).archive = { ...archive, bytes: archive.bytes.slice() };
  }

  async exec(workspace: CloudWorkspace, request: ExecRequest) {
    this.calls.push("exec");
    this.observedExecCommands.push(request.command);
    this.state(workspace);
    this.observedExecEnvironments.push({});
    if (request.signal?.aborted) throw new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred");
    if (request.command === "wait-for-cancel") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(30_000, request.timeoutMs));
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new CloudWorkspaceError(this.name, "cancelled", "command cancelled", "deferred"));
        }, { once: true });
      });
    }
    const stdout = request.command.startsWith("printf ") ? request.command.slice(7) : "";
    if (Buffer.byteLength(stdout) > request.maxOutputBytes) {
      throw new CloudWorkspaceError(this.name, "resource_limit", "command output exceeded limit", "rejected");
    }
    return { exitCode: 0, stdout, stderr: "", providerSessionId: workspace.providerSessionId, durationMs: 1 };
  }

  async readFile(workspace: CloudWorkspace, path: string, maxBytes: number): Promise<Uint8Array> {
    this.calls.push("readFile");
    const value = this.state(workspace).files.get(validateRelativePath(path, this.name));
    if (!value) throw new Error("file not found");
    if (value.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds read limit", "rejected");
    return value.slice();
  }

  async writeFile(workspace: CloudWorkspace, path: string, data: Uint8Array, maxBytes: number): Promise<void> {
    this.calls.push("writeFile");
    if (data.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "file exceeds write limit", "rejected");
    this.state(workspace).files.set(validateRelativePath(path, this.name), data.slice());
  }

  async listFiles(workspace: CloudWorkspace, path: string, maxEntries: number): Promise<string[]> {
    this.calls.push("listFiles");
    const prefix = validateRelativePath(path, this.name).replace(/\/$/, "");
    const values = [...this.state(workspace).files.keys()].filter((value) => value === prefix || value.startsWith(`${prefix}/`));
    if (values.length > maxEntries) throw new CloudWorkspaceError(this.name, "resource_limit", "file listing exceeds limit", "rejected");
    return values;
  }

  async checkpoint(workspace: CloudWorkspace, input: {
    jobId: string;
    attempt: number;
    baseSha: string;
    sourceArchiveSha256: string;
    sourceArchiveBytes: number;
    runtime: string;
    lockfileDigest: string;
    template: string;
    attemptKey: string;
    causationId: string;
  }): Promise<{ manifest: WorkspaceCheckpoint; archive: Uint8Array }> {
    this.calls.push("checkpoint");
    const state = this.state(workspace);
    if (!state.archive) throw new CloudWorkspaceError(this.name, "checkpoint_incompatible", "fake source archive is missing", "rejected");
    if (state.archive.sha256 !== input.sourceArchiveSha256 || state.archive.bytes.byteLength !== input.sourceArchiveBytes) {
      throw new CloudWorkspaceError(this.name, "checkpoint_tampered", "fake source archive binding changed", "rejected");
    }
    const archive = createPortableCheckpointArchive(state.archive, state.patch);
    return {
      archive,
      manifest: {
        version: 2,
        jobId: input.jobId,
        attempt: input.attempt,
        provider: this.name,
        providerWorkspaceId: workspace.providerWorkspaceId,
        providerSessionId: workspace.providerSessionId,
        providerCheckpointId: `fake-checkpoint-${workspace.providerWorkspaceId}`,
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
      },
    };
  }

  async recreateFromCheckpoint(input: {
    checkpoint: WorkspaceCheckpoint;
    archive: Uint8Array;
    limits: WorkspaceLimits;
    attemptKey: string;
  }): Promise<CloudWorkspace> {
    this.calls.push("recreateFromCheckpoint");
    const restored = validatePortableCheckpointArchive(input.archive, input.checkpoint, input.limits);
    const workspace = await this.createWorkspace({
      attemptKey: input.attemptKey,
      template: input.checkpoint.template,
      runtime: input.checkpoint.runtime,
      lockfileDigest: input.checkpoint.lockfileDigest,
      limits: input.limits,
    });
    this.state(workspace).archive = {
      baseSha: input.checkpoint.baseSha,
      sha256: input.checkpoint.sourceArchiveSha256,
      bytes: restored.source.bytes.slice(),
    };
    this.state(workspace).patch = restored.patch.patch.slice();
    return workspace;
  }

  async exportPatch(workspace: CloudWorkspace, baseSha: string, maxBytes: number): Promise<PatchManifest> {
    this.calls.push("exportPatch");
    const patch = this.state(workspace).patch.slice();
    if (patch.byteLength > maxBytes) throw new CloudWorkspaceError(this.name, "resource_limit", "patch exceeds limit", "rejected");
    return { baseSha, sha256: sha256Bytes(patch), byteCount: patch.byteLength, patch };
  }

  async terminate(workspace: CloudWorkspace, reason: "terminal" | "orphan" | "cancelled"): Promise<void> {
    this.calls.push(`terminate:${reason}`);
    this.state(workspace, true).terminated = true;
  }

  setPatch(workspace: CloudWorkspace, patch: string | Uint8Array): void {
    this.state(workspace).patch = typeof patch === "string" ? new TextEncoder().encode(patch) : patch.slice();
  }

  resume(workspace: CloudWorkspace): CloudWorkspace {
    this.calls.push("resume");
    return this.state(workspace).workspace;
  }

  isTerminated(workspace: CloudWorkspace): boolean { return this.state(workspace, true).terminated; }

  private state(workspace: CloudWorkspace, allowTerminated = false): FakeState {
    assertWorkspaceIdentity(workspace);
    const state = this.states.get(workspace.providerWorkspaceId);
    if (!state || state.workspace.providerSessionId !== workspace.providerSessionId) {
      throw new CloudWorkspaceError(this.name, "stale_attempt", "workspace/session fence is stale", "rejected");
    }
    if (state.terminated && !allowTerminated) throw new CloudWorkspaceError(this.name, "stale_attempt", "workspace is terminal", "rejected");
    return state;
  }
}
