import { spawn } from "node:child_process";
import {
  DEFAULT_WORKSPACE_LIMITS,
  assertRequiredCapabilities,
  controllerApplyValidatedPatch,
  sha256Bytes,
  validateCredentiallessArchive,
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
}): Promise<{ provider: CloudWorkspaceProvider; workspace: CloudWorkspace; archive: CredentiallessArchive }> {
  // Provider configuration and capabilities are resolved before the trusted
  // controller runs git or any other host process. This ordering is the
  // fail-closed missing-key/no-host-spawn invariant.
  const provider = input.providerFactory();
  assertRequiredCapabilities(provider);
  const limits = input.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const archive = await input.hydrateArchive();
  validateCredentiallessArchive(archive, limits, provider.name);
  const workspace = await provider.createWorkspace({
    attemptKey: input.attemptKey,
    template: input.template,
    runtime: input.runtime,
    lockfileDigest: input.lockfileDigest,
    limits,
  });
  if (input.bindWorkspace && !await input.bindWorkspace(workspace)) {
    await provider.terminate(workspace, "orphan").catch(() => undefined);
    throw new Error("Convex rejected the provider workspace/session fence");
  }
  try {
    await provider.uploadCredentiallessArchive(workspace, archive);
  } catch (error) {
    await provider.terminate(workspace, "terminal").catch(() => undefined);
    throw error;
  }
  return { provider, workspace, archive };
}

export async function persistPortableCheckpoint(input: {
  provider: CloudWorkspaceProvider;
  workspace: CloudWorkspace;
  store: CheckpointStore;
  baseSha: string;
  runtime: string;
  lockfileDigest: string;
  template: string;
  attemptKey: string;
  causationId: string;
}): Promise<{ manifest: WorkspaceCheckpoint; ref: string; digest: string; byteCount: number }> {
  const checkpoint = await input.provider.checkpoint(input.workspace, {
    baseSha: input.baseSha,
    runtime: input.runtime,
    lockfileDigest: input.lockfileDigest,
    template: input.template,
    attemptKey: input.attemptKey,
    causationId: input.causationId,
  });
  const stored = await input.store.put(checkpoint.manifest, checkpoint.archive);
  return { manifest: checkpoint.manifest, ...stored };
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
