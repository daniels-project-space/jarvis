import { spawn } from "node:child_process";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  assertRequiredCapabilities,
  assertWorkspaceCheckpointBinding,
  controllerApplyValidatedPatch,
  parseCheckpointReceiptManifest,
  sha256Bytes,
  validateCredentiallessArchive,
  validatePortableCheckpointArchive,
  type CheckpointStore,
  type CloudWorkspace,
  type CloudWorkspaceProvider,
  type CredentiallessArchive,
  type WorkspaceCheckpoint,
  type WorkspaceLimits,
} from "./cloud-workspace";

function boundedProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: Uint8Array; maxBytes: number; timeoutMs: number },
): Promise<{ code: number | null; stdout: Uint8Array; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(chunks), stderr });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${command} timed out`)); }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) { child.kill("SIGKILL"); finish(new Error(`${command} output exceeded limit`)); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function boundedProviderWorkspaceName(workspace: CloudWorkspace): string {
  return workspace.providerWorkspaceId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96);
}

async function terminateOrCleanupBlocked(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
  reason: "terminal" | "orphan" | "cancelled",
  context: string,
): Promise<void> {
  try { await provider.terminate(workspace, reason); }
  catch {
    throw new CloudWorkspaceError(
      provider.name,
      "cleanup_blocked",
      `${context}: ${boundedProviderWorkspaceName(workspace)}`,
      "blocked",
    );
  }
}

async function invokePostCreateCallback<T>(
  provider: CloudWorkspaceProvider,
  workspace: CloudWorkspace,
  callback: () => Promise<T>,
  context: string,
): Promise<T> {
  try { return await callback(); }
  catch (error) {
    await terminateOrCleanupBlocked(provider, workspace, "orphan", context);
    throw error;
  }
}

export async function createCredentiallessGitArchive(
  checkout: string,
  baseSha: string,
  env: NodeJS.ProcessEnv,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
): Promise<CredentiallessArchive> {
  const archived = await boundedProcess("git", ["archive", "--format=tar", baseSha], {
    cwd: checkout, env, maxBytes: limits.maxArchiveBytes, timeoutMs: 120_000,
  });
  if (archived.code !== 0) throw new Error(`git archive failed (${String(archived.code)}): ${archived.stderr}`);
  const archive = { baseSha, bytes: archived.stdout, sha256: sha256Bytes(archived.stdout) };
  validateCredentiallessArchive(archive, limits);
  return archive;
}

export async function applyValidatedPatchToControllerCheckout(
  checkout: string,
  expectedBaseSha: string,
  patch: Awaited<ReturnType<CloudWorkspaceProvider["exportPatch"]>>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await controllerApplyValidatedPatch(patch, expectedBaseSha, async (bytes) => {
    const applied = await boundedProcess("git", ["apply", "--index", "--whitespace=nowarn", "-"], {
      cwd: checkout, env, input: bytes, maxBytes: 256 * 1024, timeoutMs: 120_000,
    });
    if (applied.code !== 0) throw new Error(`trusted controller rejected patch (${String(applied.code)}): ${applied.stderr}`);
  });
}

export async function prepareCloudWorkspaceExecution(input: {
  providerFactory: () => CloudWorkspaceProvider;
  hydrateArchive: () => Promise<CredentiallessArchive>;
  attemptKey: string;
  template: string;
  runtime: string;
  lockfileDigest: string;
  limits?: WorkspaceLimits;
  bindWorkspace?: (workspace: CloudWorkspace) => Promise<boolean>;
  assertCurrent?: (phase: string) => Promise<boolean>;
}): Promise<{ provider: CloudWorkspaceProvider; workspace: CloudWorkspace; archive: CredentiallessArchive }> {
  // Provider configuration and capabilities are resolved before the trusted
  // controller runs git or any other host process. This ordering is the
  // fail-closed missing-key/no-host-spawn invariant.
  const provider = input.providerFactory();
  assertRequiredCapabilities(provider);
  const limits = input.limits ?? DEFAULT_WORKSPACE_LIMITS;
  if (input.assertCurrent && !await input.assertCurrent("source_hydration")) {
    throw new CloudWorkspaceError(provider.name, "stale_attempt", "attempt fence rejected source hydration", "deferred");
  }
  const archive = await input.hydrateArchive();
  validateCredentiallessArchive(archive, limits, provider.name);
  if (input.assertCurrent && !await input.assertCurrent("workspace_creation")) {
    throw new CloudWorkspaceError(provider.name, "stale_attempt", "attempt fence rejected workspace creation", "deferred");
  }
  const workspace = await provider.createWorkspace({
    attemptKey: input.attemptKey,
    template: input.template,
    runtime: input.runtime,
    lockfileDigest: input.lockfileDigest,
    limits,
  });
  const bindingLeaseCurrent = input.assertCurrent
    ? await invokePostCreateCallback(
        provider,
        workspace,
        () => input.assertCurrent!("workspace_binding"),
        "could not clean workspace after the binding lease check failed",
      )
    : true;
  if (!bindingLeaseCurrent) {
    await terminateOrCleanupBlocked(provider, workspace, "orphan", "could not clean workspace after the binding lease was lost");
    throw new CloudWorkspaceError(provider.name, "stale_attempt", "attempt fence rejected workspace binding", "deferred");
  }
  const workspaceBound = input.bindWorkspace
    ? await invokePostCreateCallback(
        provider,
        workspace,
        () => input.bindWorkspace!(workspace),
        "could not clean workspace after durable binding failed",
      )
    : true;
  if (!workspaceBound) {
    await terminateOrCleanupBlocked(provider, workspace, "orphan", "could not clean workspace after durable binding was rejected");
    throw new Error("Convex rejected the provider workspace/session fence");
  }
  try {
    if (input.assertCurrent && !await input.assertCurrent("source_upload")) {
      throw new CloudWorkspaceError(provider.name, "stale_attempt", "attempt fence rejected source upload", "deferred");
    }
    await provider.uploadCredentiallessArchive(workspace, archive);
    // Dependency hydration is a provider-specific, controller-owned phase.
    // It must finish and relock egress before the caller can reach Codex.
    if (provider.hydrateDependencies) {
      if (input.assertCurrent && !await input.assertCurrent("dependency_hydration")) {
        throw new CloudWorkspaceError(provider.name, "stale_attempt", "attempt fence rejected dependency hydration", "deferred");
      }
      await provider.hydrateDependencies(workspace);
      if (input.assertCurrent && !await input.assertCurrent("dependency_relocked")) {
        throw new CloudWorkspaceError(provider.name, "stale_attempt", "attempt fence rejected dependency relock", "deferred");
      }
    }
  } catch (error) {
    await terminateOrCleanupBlocked(provider, workspace, "terminal", "could not clean workspace after preparation failed");
    throw error;
  }
  return { provider, workspace, archive };
}

export type PortableCheckpointReceipt = {
  sourceAttempt: number;
  checkpointRef: string;
  checkpointDigest: string;
  checkpointBytes: number;
  checkpointManifest: string;
  checkpointManifestDigest: string;
};

export async function replayCloudWorkspaceExecution(input: {
  provider: CloudWorkspaceProvider;
  store: CheckpointStore;
  receipt: PortableCheckpointReceipt;
  current: {
    jobId: string;
    attempt: number;
    baseSha: string;
    sourceArchiveSha256: string;
    sourceArchiveBytes: number;
    runtime: string;
    lockfileDigest: string;
    template: string;
    attemptKey: string;
  };
  limits?: WorkspaceLimits;
  assertCurrent: (phase: string) => Promise<boolean>;
  bindWorkspace: (workspace: CloudWorkspace) => Promise<boolean>;
}): Promise<{ provider: CloudWorkspaceProvider; workspace: CloudWorkspace; checkpoint: WorkspaceCheckpoint; archive: Uint8Array }> {
  assertRequiredCapabilities(input.provider);
  const checkpoint = parseCheckpointReceiptManifest(input.receipt.checkpointManifest, input.receipt.checkpointManifestDigest);
  const expectedPriorAttempt = input.receipt.sourceAttempt;
  if (!Number.isSafeInteger(expectedPriorAttempt) || expectedPriorAttempt < 1 || expectedPriorAttempt >= input.current.attempt) {
    throw new CloudWorkspaceError(input.provider.name, "checkpoint_incompatible", "checkpoint source attempt is invalid", "rejected");
  }
  if (checkpoint.jobId !== input.current.jobId || checkpoint.attempt !== expectedPriorAttempt
    || checkpoint.attemptKey !== `${input.current.jobId}:${expectedPriorAttempt}`
    || checkpoint.provider !== input.provider.name
    || checkpoint.baseSha !== input.current.baseSha
    || checkpoint.sourceArchiveSha256 !== input.current.sourceArchiveSha256
    || checkpoint.sourceArchiveBytes !== input.current.sourceArchiveBytes
    || checkpoint.runtime !== input.current.runtime
    || checkpoint.lockfileDigest !== input.current.lockfileDigest
    || checkpoint.template !== input.current.template) {
    throw new CloudWorkspaceError(input.provider.name, "checkpoint_incompatible", "checkpoint replay bindings do not match the current fenced attempt", "rejected");
  }
  if (checkpoint.archiveSha256 !== input.receipt.checkpointDigest
    || checkpoint.archiveBytes !== input.receipt.checkpointBytes
    || input.receipt.checkpointRef !== `sandbox-checkpoints/sha256/${input.receipt.checkpointDigest}`) {
    throw new CloudWorkspaceError(input.provider.name, "checkpoint_tampered", "checkpoint receipt conflicts with its canonical manifest", "rejected");
  }
  if (!await input.assertCurrent("checkpoint_read")) {
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected checkpoint read", "deferred");
  }
  const archive = await input.store.get(input.receipt.checkpointRef, input.receipt.checkpointDigest, input.receipt.checkpointBytes);
  validatePortableCheckpointArchive(archive, checkpoint, input.limits ?? DEFAULT_WORKSPACE_LIMITS);
  if (!await input.assertCurrent("checkpoint_recreation")) {
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected checkpoint recreation", "deferred");
  }
  const workspace = await input.provider.recreateFromCheckpoint({
    checkpoint,
    archive,
    limits: input.limits ?? DEFAULT_WORKSPACE_LIMITS,
    attemptKey: input.current.attemptKey,
  });
  if (workspace.providerWorkspaceId === checkpoint.providerWorkspaceId
    || workspace.providerSessionId === checkpoint.providerSessionId) {
    await terminateOrCleanupBlocked(input.provider, workspace, "orphan", "could not clean replay workspace after terminal identity reuse");
    throw new CloudWorkspaceError(input.provider.name, "checkpoint_tampered", "checkpoint replay reused a terminal provider identity", "rejected");
  }
  const replayLeaseCurrent = await invokePostCreateCallback(
    input.provider,
    workspace,
    () => input.assertCurrent("replay_binding"),
    "could not clean replay workspace after the binding lease check failed",
  );
  if (!replayLeaseCurrent) {
    await terminateOrCleanupBlocked(input.provider, workspace, "orphan", "could not clean replay workspace after binding was rejected");
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected replay workspace binding", "deferred");
  }
  const replayWorkspaceBound = await invokePostCreateCallback(
    input.provider,
    workspace,
    () => input.bindWorkspace(workspace),
    "could not clean replay workspace after durable binding failed",
  );
  if (!replayWorkspaceBound) {
    await terminateOrCleanupBlocked(input.provider, workspace, "orphan", "could not clean replay workspace after binding was rejected");
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected replay workspace binding", "deferred");
  }
  return { provider: input.provider, workspace, checkpoint, archive };
}

export async function persistPortableCheckpoint(input: {
  provider: CloudWorkspaceProvider;
  workspace: CloudWorkspace;
  store: CheckpointStore;
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
  assertCurrent?: (phase: string) => Promise<boolean>;
}): Promise<{ manifest: WorkspaceCheckpoint; ref: string; digest: string; byteCount: number; canonicalManifest: string; manifestDigest: string }> {
  if (input.assertCurrent && !await input.assertCurrent("checkpoint_export")) {
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected checkpoint export", "deferred");
  }
  const checkpoint = await input.provider.checkpoint(input.workspace, {
    jobId: input.jobId,
    attempt: input.attempt,
    baseSha: input.baseSha,
    sourceArchiveSha256: input.sourceArchiveSha256,
    sourceArchiveBytes: input.sourceArchiveBytes,
    runtime: input.runtime,
    lockfileDigest: input.lockfileDigest,
    template: input.template,
    attemptKey: input.attemptKey,
    causationId: input.causationId,
  });
  assertWorkspaceCheckpointBinding(checkpoint.manifest, {
    jobId: input.jobId, attempt: input.attempt, provider: input.provider.name,
    baseSha: input.baseSha, sourceArchiveSha256: input.sourceArchiveSha256,
    sourceArchiveBytes: input.sourceArchiveBytes, runtime: input.runtime,
    lockfileDigest: input.lockfileDigest, template: input.template,
    attemptKey: input.attemptKey, causationId: input.causationId,
  });
  if (checkpoint.manifest.providerWorkspaceId !== input.workspace.providerWorkspaceId
    || checkpoint.manifest.providerSessionId !== input.workspace.providerSessionId) {
    throw new CloudWorkspaceError(input.provider.name, "checkpoint_tampered", "checkpoint provider identity changed", "rejected");
  }
  validatePortableCheckpointArchive(checkpoint.archive, checkpoint.manifest);
  if (input.assertCurrent && !await input.assertCurrent("checkpoint_store")) {
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected checkpoint store", "deferred");
  }
  const stored = await input.store.put(checkpoint.manifest, checkpoint.archive);
  if (input.assertCurrent && !await input.assertCurrent("checkpoint_record")) {
    throw new CloudWorkspaceError(input.provider.name, "stale_attempt", "attempt fence rejected checkpoint record", "deferred");
  }
  return {
    manifest: checkpoint.manifest,
    ref: stored.ref,
    digest: stored.digest,
    byteCount: stored.byteCount,
    canonicalManifest: stored.manifest,
    manifestDigest: stored.manifestDigest,
  };
}

export async function terminateOrphanedCloudWorkspaces(
  orphans: Array<{ provider: CloudWorkspaceProvider; workspace: CloudWorkspace }>,
): Promise<{ terminated: number; failed: number }> {
  let terminated = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try { await orphan.provider.terminate(orphan.workspace, "orphan"); terminated += 1; }
    catch { failed += 1; }
  }
  return { terminated, failed };
}
