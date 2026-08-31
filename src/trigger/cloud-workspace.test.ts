import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CloudWorkspaceError,
  ContentAddressedCheckpointStore,
  DEFAULT_WORKSPACE_LIMITS,
  assertRequiredCapabilities,
  createPortableCheckpointArchive,
  controllerApplyValidatedPatch,
  sha256Bytes,
  validateCredentiallessArchive,
  validatePatchManifest,
  validatePortableCheckpointArchive,
  type CloudWorkspaceProvider,
  type CredentiallessArchive,
  type PatchManifest,
} from "./cloud-workspace";
import { FakeCloudWorkspaceProvider } from "./cloud-workspace-fake";
import { CloudWorkspaceToolBridge, cloudRepositoryToolsForScope } from "./cloud-workspace-tools";
import {
  CLOUD_WORKSPACE_HEARTBEAT_TIMEOUT_MS,
  persistPortableCheckpoint,
  prepareCloudWorkspaceExecution,
  replayCloudWorkspaceExecution,
  terminateOrphanedCloudWorkspaces,
} from "./cloud-workspace-controller";
import {
  CLOUD_WORKSPACE_CAPABILITY_MATRIX,
  configuredCloudWorkspaceCleanupProvider,
  configuredCloudWorkspaceProvider,
} from "./cloud-workspace-providers";
import { canonicalWorkspaceCheckpoint } from "../lib/workspace-checkpoint";

const BASE = "a".repeat(40);
const JOB = "job-checkpoint-replay";
const LOCK = "b".repeat(64);

function toolText(outcome: Awaited<ReturnType<CloudWorkspaceToolBridge["invoke"]>>): string {
  const item = outcome.contentItems[0];
  if (!item || item.type !== "inputText") throw new Error("expected a text tool result");
  return item.text;
}

function tar(entries: Array<{ name: string; type?: string; data?: Uint8Array; size?: number }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.name).subarray(0, 100), 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    const data = entry.data ?? new Uint8Array(entry.size ?? 0);
    const size = entry.size ?? data.byteLength;
    header.set(encoder.encode(size.toString(8).padStart(11, "0") + "\0"), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header, data, new Uint8Array((512 - (data.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return Buffer.concat(blocks.map((block) => Buffer.from(block)));
}

function archive(entries: Parameters<typeof tar>[0]): CredentiallessArchive {
  const bytes = tar(entries);
  return { baseSha: BASE, sha256: sha256Bytes(bytes), bytes };
}

function patch(text: string, baseSha = BASE): PatchManifest {
  const bytes = new TextEncoder().encode(text);
  return { baseSha, sha256: sha256Bytes(bytes), byteCount: bytes.byteLength, patch: bytes };
}

async function storedCheckpointFixture() {
  const objects = new Map<string, Uint8Array>();
  const store = new ContentAddressedCheckpointStore(
    async (key, value) => { objects.set(key, value.slice()); },
    async (key) => objects.get(key)?.slice() ?? null,
  );
  const provider = new FakeCloudWorkspaceProvider();
  const source = archive([{ name: "README.md", data: new TextEncoder().encode("base\n") }]);
  const first = await provider.createWorkspace({ attemptKey: `${JOB}:1`, template: "node", runtime: "node-22", lockfileDigest: LOCK, limits: DEFAULT_WORKSPACE_LIMITS });
  await provider.uploadCredentiallessArchive(first, source);
  provider.setPatch(first, "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+edited\n");
  const stored = await persistPortableCheckpoint({
    provider, workspace: first, store, jobId: JOB, attempt: 1, baseSha: BASE,
    sourceArchiveSha256: source.sha256, sourceArchiveBytes: source.bytes.byteLength,
    runtime: "node-22", lockfileDigest: LOCK, template: "node",
    attemptKey: `${JOB}:1`, causationId: "run-1:1", assertCurrent: async () => true,
  });
  const receipt = {
    sourceAttempt: 1,
    checkpointRef: stored.ref, checkpointDigest: stored.digest, checkpointBytes: stored.byteCount,
    checkpointManifest: stored.canonicalManifest, checkpointManifestDigest: stored.manifestDigest,
  };
  const current = {
    jobId: JOB, attempt: 2, baseSha: BASE, sourceArchiveSha256: source.sha256,
    sourceArchiveBytes: source.bytes.byteLength, runtime: "node-22", lockfileDigest: LOCK,
    template: "node", attemptKey: `${JOB}:2`,
  };
  return { objects, store, provider, source, first, stored, receipt, current };
}

describe("fail-closed cloud workspace boundary", () => {
  it("orchestrates attempt 1 edit -> R2 checkpoint -> termination -> attempt 2 exact replay with a safe preserved patch", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const source = archive([{ name: "README.md", data: new TextEncoder().encode("base") }]);
    const objects = new Map<string, Uint8Array>();
    const store = new ContentAddressedCheckpointStore(
      async (key, value) => { objects.set(key, value.slice()); },
      async (key) => objects.get(key)?.slice() ?? null,
    );
    const first = await provider.createWorkspace({ attemptKey: `${JOB}:1`, template: "node", runtime: "node-22", lockfileDigest: LOCK, limits: DEFAULT_WORKSPACE_LIMITS });
    await provider.uploadCredentiallessArchive(first, source);
    await provider.writeFile(first, "src/value.ts", new TextEncoder().encode("export const value = 1;"), 1_000);
    provider.setPatch(first, "diff --git a/src/value.ts b/src/value.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/value.ts\n@@ -0,0 +1 @@\n+export const value = 1;\n");
    await expect(provider.exec(first, { command: "printf ready", timeoutMs: 1_000, maxOutputBytes: 1_000 })).resolves.toMatchObject({ stdout: "ready" });
    const checkpoint = await persistPortableCheckpoint({
      provider, workspace: first, store, jobId: JOB, attempt: 1, baseSha: BASE,
      sourceArchiveSha256: source.sha256, sourceArchiveBytes: source.bytes.byteLength,
      runtime: "node-22", lockfileDigest: LOCK, template: "node",
      attemptKey: `${JOB}:1`, causationId: "run-1:1", assertCurrent: async () => true,
    });
    await provider.terminate(first, "terminal");
    expect(provider.isTerminated(first)).toBe(true);
    const replayed = await replayCloudWorkspaceExecution({
      provider, store,
      receipt: {
        sourceAttempt: 1,
        checkpointRef: checkpoint.ref, checkpointDigest: checkpoint.digest,
        checkpointBytes: checkpoint.byteCount, checkpointManifest: checkpoint.canonicalManifest,
        checkpointManifestDigest: checkpoint.manifestDigest,
      },
      current: {
        jobId: JOB, attempt: 2, baseSha: BASE, sourceArchiveSha256: source.sha256,
        sourceArchiveBytes: source.bytes.byteLength, runtime: "node-22", lockfileDigest: LOCK,
        template: "node", attemptKey: `${JOB}:2`,
      },
      assertCurrent: async () => true,
      bindWorkspace: async () => true,
    });
    expect(replayed.workspace.providerWorkspaceId).not.toBe(first.providerWorkspaceId);
    expect(replayed.workspace.providerSessionId).not.toBe(first.providerSessionId);
    const exported = await provider.exportPatch(replayed.workspace, BASE, DEFAULT_WORKSPACE_LIMITS.maxArchiveBytes);
    expect(new TextDecoder().decode(exported.patch)).toContain("export const value = 1");
    validatePatchManifest(exported, BASE);
    await provider.terminate(replayed.workspace, "terminal");
    expect(provider.isTerminated(replayed.workspace)).toBe(true);
    expect(Object.keys(checkpoint)).not.toContain("archive");
    expect(provider.calls).toEqual(expect.arrayContaining(["createWorkspace", "uploadCredentiallessArchive", "exec", "checkpoint", "terminate:terminal", "recreateFromCheckpoint"]));
  });

  it("resolves missing configuration before hydration and therefore before host spawn", async () => {
    const hydrate = vi.fn(async () => archive([{ name: "safe.txt", data: new TextEncoder().encode("safe") }]));
    await expect(prepareCloudWorkspaceExecution({
      providerFactory: () => configuredCloudWorkspaceProvider({}, { triggerDeploymentVersion: undefined }),
      hydrateArchive: hydrate,
      attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64),
    })).rejects.toMatchObject({ code: "missing_configuration" });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("revalidates authority after provider listing and stops before a stale create effect", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    Object.defineProperty(provider, "name", { value: "vercel" });
    const create = provider.createWorkspace.bind(provider);
    provider.createWorkspace = async (input: Parameters<CloudWorkspaceProvider["createWorkspace"]>[0]) => {
      await input.onStage?.("provider_list");
      await input.onStage?.("provider_create");
      return await create(input);
    };
    const phases: string[] = [];
    const stages: string[] = [];
    await expect(prepareCloudWorkspaceExecution({
      providerFactory: () => provider,
      hydrateArchive: async () => archive([{ name: "safe.txt", data: new TextEncoder().encode("safe") }]),
      attemptKey: "stale-after-list:1",
      template: "node",
      runtime: "node-22",
      lockfileDigest: LOCK,
      assertCurrent: async (phase) => {
        phases.push(phase);
        return phase !== "provider_create";
      },
      onStage: async (stage) => { stages.push(stage); },
    })).rejects.toMatchObject({ code: "stale_attempt", disposition: "deferred" });
    expect(phases).toEqual(["source_hydration", "workspace_creation", "provider_list", "provider_create"]);
    expect(stages).toEqual(["provider_list"]);
    expect(provider.calls).not.toContain("createWorkspace");
  });

  it("runs the controller-owned dependency phase after upload and terminates before an agent boundary when it fails", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const events: string[] = [];
    const upload = provider.uploadCredentiallessArchive.bind(provider);
    provider.uploadCredentiallessArchive = async (workspace, source) => { events.push("upload"); await upload(workspace, source); };
    const dependencyProvider = provider as typeof provider & { hydrateDependencies: () => Promise<void> };
    dependencyProvider.hydrateDependencies = async () => { events.push("dependency"); throw new CloudWorkspaceError("sandbox0", "provider_unavailable", "install failed", "deferred"); };
    await expect(prepareCloudWorkspaceExecution({
      providerFactory: () => provider,
      hydrateArchive: async () => archive([{ name: "package-lock.json", data: new TextEncoder().encode("{}") }]),
      attemptKey: "dependency-failure:1", template: "node", runtime: "node-22", lockfileDigest: LOCK,
    })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(events).toEqual(["upload", "dependency"]);
    expect(provider.calls).toContain("terminate:terminal");
  });

  it("keeps a quiet dependency hydration alive without inventing a new progress stage", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeCloudWorkspaceProvider();
      let releaseHydration!: () => void;
      let hydrationStarted!: () => void;
      const started = new Promise<void>((resolve) => { hydrationStarted = resolve; });
      const hydration = new Promise<void>((resolve) => { releaseHydration = resolve; });
      const dependencyProvider = provider as typeof provider & { hydrateDependencies: () => Promise<void> };
      dependencyProvider.hydrateDependencies = async () => {
        hydrationStarted();
        await hydration;
      };
      const stages: string[] = [];
      const heartbeats: string[] = [];
      const pending = prepareCloudWorkspaceExecution({
        providerFactory: () => provider,
        hydrateArchive: async () => archive([{ name: "package-lock.json", data: new TextEncoder().encode("{}") }]),
        attemptKey: "quiet-dependency:1",
        template: "node",
        runtime: "node-22",
        lockfileDigest: LOCK,
        onStage: async (stage) => { stages.push(stage); },
        onHeartbeat: async (stage, signal) => {
          heartbeats.push(stage);
          // A single stalled control-plane request must not suppress every
          // later pulse. The controller bounds it and retries on the next
          // cadence without overlapping heartbeat requests.
          if (heartbeats.length === 1) {
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("heartbeat timeout")),
                { once: true },
              );
            });
          }
        },
      });

      await started;
      await vi.advanceTimersByTimeAsync(60_000 + CLOUD_WORKSPACE_HEARTBEAT_TIMEOUT_MS);
      expect(heartbeats).toEqual(["dependency_hydration", "dependency_hydration"]);
      expect(stages).toEqual(["provider_create", "source_upload", "dependency_hydration"]);

      releaseHydration();
      await pending;
      expect(provider.calls).not.toContain("terminate:terminal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never projects controller secrets or caller env into sandbox execution", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    const bridge = new CloudWorkspaceToolBridge(provider, workspace, {
      allowedToolScope: ["repository_exec", "repository_read_file", "repository_list_files", "repository_write_file"],
    });
    await bridge.invoke({ threadId: "t", turnId: "r", callId: "c", namespace: null, tool: "repository_exec", arguments: { command: "printf clean" } });
    expect(provider.observedExecEnvironments).toEqual([{}]);
    expect(JSON.stringify(provider.observedExecEnvironments)).not.toMatch(/OPENAI|CODEX|GITHUB|CONVEX|TRIGGER|VAULT|TOKEN|SECRET/);
  });

  it("does not advertise or execute write tools for a read-only work order", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "readonly:1", template: "node", runtime: "node-22", lockfileDigest: "c".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    const bridge = new CloudWorkspaceToolBridge(provider, workspace, {
      allowedToolScope: ["repository_validate", "repository_read_file", "repository_list_files"],
    });
    const outcome = await bridge.invoke({
      threadId: "t", turnId: "r", callId: "c", namespace: null,
      tool: "repository_write_file", arguments: { path: "blocked.txt", content: "nope" },
    });
    expect(outcome.success).toBe(false);
    expect(provider.calls).not.toContain("writeFile");
    expect(cloudRepositoryToolsForScope(["repository_validate", "repository_read_file", "repository_list_files"])
      .map((tool) => tool.name)).toEqual(["repository_validate", "repository_read_file", "repository_list_files"]);
  });

  it("lets read-only work run fixed local validation without accepting shell authority", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "readonly-validation:1", template: "node", runtime: "node-22",
      lockfileDigest: "d".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    const bridge = new CloudWorkspaceToolBridge(provider, workspace, {
      allowedToolScope: ["repository_validate", "repository_read_file", "repository_list_files"],
      sourceBinding: { sourceHeadSha: "a".repeat(40), workspaceBaseSha: "a".repeat(40) },
    });
    const valid = await bridge.invoke({
      threadId: "t", turnId: "r", callId: "validate", namespace: null,
      tool: "repository_validate",
      arguments: { kind: "tests", paths: ["src/lib/agent-fleet-dispatch.test.ts", "convex/jobsClaim.test.ts"] },
    });
    expect(valid.success).toBe(true);
    expect(JSON.parse(toolText(valid))).toMatchObject({
      kind: "tests",
      success: true,
      reportAccepted: true,
      unexpectedFiles: 0,
      totals: { tests: 2, passed: 2, failed: 0 },
      sourceBinding: {
        authority: "controller_bound_source_v1",
        sourceHeadSha: "a".repeat(40),
        workspaceBaseSha: "a".repeat(40),
        exactSourceBound: true,
        sandboxGitIdentity: "synthetic_credentialless_transport",
      },
      files: [
        { path: "src/lib/agent-fleet-dispatch.test.ts", reported: true, tests: 1, passed: 1 },
        { path: "convex/jobsClaim.test.ts", reported: true, tests: 1, passed: 1 },
      ],
    });
    expect(provider.observedExecCommands).toEqual([
      "npx vitest run --reporter=json src/lib/agent-fleet-dispatch.test.ts convex/jobsClaim.test.ts",
    ]);

    const typecheck = await bridge.invoke({
      threadId: "t", turnId: "r", callId: "typecheck", namespace: null,
      tool: "repository_validate", arguments: { kind: "typecheck" },
    });
    expect(typecheck.success).toBe(true);
    expect(provider.observedExecCommands[1]).toBe("npx tsc --noEmit --pretty false");

    const injected = await bridge.invoke({
      threadId: "t", turnId: "r", callId: "inject", namespace: null,
      tool: "repository_validate",
      arguments: { kind: "tests", paths: ["src/lib/safe.test.ts; touch owned"] },
    });
    const traversed = await bridge.invoke({
      threadId: "t", turnId: "r", callId: "traverse", namespace: null,
      tool: "repository_validate",
      arguments: { kind: "tests", paths: ["../outside.test.ts"] },
    });
    expect(injected.success).toBe(false);
    expect(traversed.success).toBe(false);
    expect(provider.observedExecCommands).toHaveLength(2);
  });

  it("returns aggregate test evidence without exposing secret-like reporter content", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({
      attemptKey: "readonly-validation-redaction:1", template: "node", runtime: "node-22",
      lockfileDigest: "e".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS,
    });
    vi.spyOn(provider, "exec").mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        numTotalTestSuites: 1,
        numPassedTestSuites: 1,
        numFailedTestSuites: 0,
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        testResults: [{
          name: `${workspace.root}/src/lib/safe.test.ts`,
          status: "passed",
          message: "access_token=abcdefghijklmnopqrstuvwxyz123456",
          assertionResults: [
            { title: "fixture access_token=abcdefghijklmnopqrstuvwxyz123456", status: "passed" },
            { title: "another safe assertion", status: "passed" },
          ],
        }],
      }),
      stderr: "access_token=abcdefghijklmnopqrstuvwxyz123456",
      providerSessionId: workspace.providerSessionId,
      durationMs: 12,
    });
    const bridge = new CloudWorkspaceToolBridge(provider, workspace, {
      allowedToolScope: ["repository_validate"],
    });
    const outcome = await bridge.invoke({
      threadId: "t", turnId: "r", callId: "validate-redaction", namespace: null,
      tool: "repository_validate", arguments: { kind: "tests", paths: ["src/lib/safe.test.ts"] },
    });
    expect(outcome.success).toBe(true);
    expect(toolText(outcome)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.parse(toolText(outcome))).toMatchObject({
      success: true,
      totals: { tests: 2, passed: 2, failed: 0 },
      files: [{ path: "src/lib/safe.test.ts", tests: 2, passed: 2, failed: 0 }],
    });
  });

  it.each([
    ["traversal", { name: "../escape", type: "0" }],
    ["absolute", { name: "/etc/passwd", type: "0" }],
    ["symlink", { name: "link", type: "2" }],
    ["hardlink", { name: "link", type: "1" }],
    ["character device", { name: "device", type: "3" }],
    ["block device", { name: "device", type: "4" }],
    ["pax path override", { name: "PaxHeaders/path", type: "x" }],
    ["empty global pax override", { name: "pax_global_header", type: "g" }],
    ["GNU long path override", { name: "long-path", type: "L" }],
    ["GNU long link override", { name: "long-link", type: "K" }],
  ])("rejects unsafe archive member: %s", (_label, member) => {
    expect(() => validateCredentiallessArchive(archive([member]))).toThrow(CloudWorkspaceError);
  });

  it("rejects oversized archive members and exact archive digest mismatches", () => {
    const oversized = archive([{ name: "huge", size: DEFAULT_WORKSPACE_LIMITS.maxFileBytes + 1 }]);
    expect(() => validateCredentiallessArchive(oversized)).toThrow(/byte limit/);
    const mismatched = archive([{ name: "safe", data: new Uint8Array([1]) }]);
    mismatched.sha256 = "0".repeat(64);
    expect(() => validateCredentiallessArchive(mismatched)).toThrow(/digest/);
  });

  it.each([
    ["traversal", patch("diff --git a/../escape b/../escape\n--- a/../escape\n+++ b/../escape\n")],
    ["absolute", patch("--- /etc/passwd\n+++ /etc/passwd\n")],
    ["binary marker", patch("diff --git a/image.png b/image.png\nGIT binary patch\n")],
    ["binary bytes", { baseSha: BASE, patch: new Uint8Array([0]), sha256: sha256Bytes(new Uint8Array([0])), byteCount: 1 }],
    ["symlink mode", patch("diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n")],
    ["gitlink mode", patch("diff --git a/nested b/nested\nnew file mode 160000\n--- /dev/null\n+++ b/nested\n")],
    ["device-like mode", patch("diff --git a/device b/device\nnew file mode 060000\n--- /dev/null\n+++ b/device\n")],
    ["changed base", patch("", "b".repeat(40))],
    ["secret", patch("diff --git a/.env b/.env\n+api_key=sk-abcdefghijklmnopqrstuvwxyz123456\n")],
  ])("rejects unsafe patch output: %s", (_label, manifest) => {
    expect(() => validatePatchManifest(manifest, BASE)).toThrow(CloudWorkspaceError);
  });

  it("rejects patch size excess before controller application", async () => {
    const manifest = patch("x".repeat(20));
    const apply = vi.fn(async () => undefined);
    await expect(controllerApplyValidatedPatch(manifest, BASE, apply)).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledOnce();
    manifest.byteCount += 1;
    await expect(controllerApplyValidatedPatch(manifest, BASE, apply)).rejects.toThrow(/byte count/);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("cancels the exact provider command and fences stale workspace sessions", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    const controller = new AbortController();
    const running = provider.exec(workspace, { command: "wait-for-cancel", timeoutMs: 30_000, maxOutputBytes: 1_000, signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    await expect(provider.exec({ ...workspace, providerSessionId: "stale-session" }, { command: "printf no", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ code: "stale_attempt" });
  });

  it("requires separate provider workspace and session identities", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    expect(workspace.providerWorkspaceId).not.toBe(workspace.providerSessionId);
    await expect(provider.exec({ ...workspace, providerSessionId: workspace.providerWorkspaceId }, { command: "printf no", timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toThrow(/separate identities/);
  });

  it("detects exact R2 checkpoint reference, digest, and byte-count mismatches", async () => {
    const objects = new Map<string, Uint8Array>();
    const store = new ContentAddressedCheckpointStore(
      async (key, value) => { objects.set(key, value.slice()); },
      async (key) => objects.get(key)?.slice() ?? null,
    );
    const provider = new FakeCloudWorkspaceProvider();
    const source = archive([{ name: "safe.txt", data: new TextEncoder().encode("safe") }]);
    const workspace = await provider.createWorkspace({ attemptKey: `${JOB}:1`, template: "node", runtime: "node-22", lockfileDigest: LOCK, limits: DEFAULT_WORKSPACE_LIMITS });
    await provider.uploadCredentiallessArchive(workspace, source);
    const checkpoint = await provider.checkpoint(workspace, {
      jobId: JOB, attempt: 1, baseSha: BASE, sourceArchiveSha256: source.sha256,
      sourceArchiveBytes: source.bytes.byteLength, runtime: "node-22", lockfileDigest: LOCK,
      template: "node", attemptKey: `${JOB}:1`, causationId: "run:1",
    });
    const stored = await store.put(checkpoint.manifest, checkpoint.archive);
    await expect(store.get(stored.ref, stored.digest, stored.byteCount)).resolves.toEqual(checkpoint.archive);
    objects.set(stored.ref, new TextEncoder().encode("tampered"));
    await expect(store.get(stored.ref, stored.digest, stored.byteCount)).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("keeps two sequential portable checkpoints content-stable instead of recursively growing", async () => {
    const fixture = await storedCheckpointFixture();
    await fixture.provider.terminate(fixture.first, "terminal");
    const replayed = await replayCloudWorkspaceExecution({
      provider: fixture.provider, store: fixture.store, receipt: fixture.receipt,
      current: fixture.current, assertCurrent: async () => true, bindWorkspace: async () => true,
    });
    const second = await persistPortableCheckpoint({
      provider: fixture.provider, workspace: replayed.workspace, store: fixture.store,
      jobId: JOB, attempt: 2, baseSha: BASE,
      sourceArchiveSha256: fixture.source.sha256, sourceArchiveBytes: fixture.source.bytes.byteLength,
      runtime: "node-22", lockfileDigest: LOCK, template: "node",
      attemptKey: `${JOB}:2`, causationId: "run-2:2", assertCurrent: async () => true,
    });
    expect(second.byteCount).toBe(fixture.stored.byteCount);
    expect(second.digest).toBe(fixture.stored.digest);
    expect(second.canonicalManifest).not.toContain("checkpointRef");
  });

  it.each([
    ["base", { baseSha: "c".repeat(40) }],
    ["lockfile", { lockfileDigest: "d".repeat(64) }],
    ["attempt", { attempt: 3 }],
  ])("rejects a checkpoint with a tampered %s binding", async (_label, change) => {
    const fixture = await storedCheckpointFixture();
    const manifest = { ...fixture.stored.manifest, ...change };
    const canonical = canonicalWorkspaceCheckpoint(manifest);
    await expect(replayCloudWorkspaceExecution({
      provider: fixture.provider, store: fixture.store,
      receipt: { ...fixture.receipt, checkpointManifest: canonical, checkpointManifestDigest: sha256Bytes(canonical) },
      current: fixture.current, assertCurrent: async () => true, bindWorkspace: async () => true,
    })).rejects.toMatchObject({ code: "checkpoint_incompatible" });
    expect(fixture.provider.calls.filter((call) => call === "recreateFromCheckpoint")).toHaveLength(0);
  });

  it("rejects tampered checkpoint bytes and a non-canonical or digest-conflicting manifest", async () => {
    const bytes = await storedCheckpointFixture();
    bytes.objects.set(bytes.stored.ref, new Uint8Array(bytes.objects.get(bytes.stored.ref)!.map((value, index) => index === 700 ? value ^ 1 : value)));
    await expect(replayCloudWorkspaceExecution({
      provider: bytes.provider, store: bytes.store, receipt: bytes.receipt, current: bytes.current,
      assertCurrent: async () => true, bindWorkspace: async () => true,
    })).rejects.toMatchObject({ code: "digest_mismatch" });

    const manifest = await storedCheckpointFixture();
    await expect(replayCloudWorkspaceExecution({
      provider: manifest.provider, store: manifest.store,
      receipt: { ...manifest.receipt, checkpointManifest: `${manifest.receipt.checkpointManifest} ` },
      current: manifest.current, assertCurrent: async () => true, bindWorkspace: async () => true,
    })).rejects.toMatchObject({ code: "checkpoint_tampered" });
  });

  it("returns a typed missing-object failure without recreating a provider workspace", async () => {
    const fixture = await storedCheckpointFixture();
    fixture.objects.delete(fixture.stored.ref);
    await expect(replayCloudWorkspaceExecution({
      provider: fixture.provider, store: fixture.store, receipt: fixture.receipt, current: fixture.current,
      assertCurrent: async () => true, bindWorkspace: async () => true,
    })).rejects.toMatchObject({ code: "checkpoint_missing" });
    expect(fixture.provider.calls.filter((call) => call === "recreateFromCheckpoint")).toHaveLength(0);
  });

  it("fences stale/cancel races before recreation and before checkpoint recording", async () => {
    const replay = await storedCheckpointFixture();
    await expect(replayCloudWorkspaceExecution({
      provider: replay.provider, store: replay.store, receipt: replay.receipt, current: replay.current,
      assertCurrent: async (phase) => phase !== "checkpoint_recreation",
      bindWorkspace: async () => true,
    })).rejects.toMatchObject({ code: "stale_attempt" });
    expect(replay.provider.calls.filter((call) => call === "recreateFromCheckpoint")).toHaveLength(0);

    const checkpoint = await storedCheckpointFixture();
    const putsBefore = checkpoint.objects.size;
    await expect(persistPortableCheckpoint({
      provider: checkpoint.provider, workspace: checkpoint.first, store: checkpoint.store,
      jobId: JOB, attempt: 1, baseSha: BASE,
      sourceArchiveSha256: checkpoint.source.sha256, sourceArchiveBytes: checkpoint.source.bytes.byteLength,
      runtime: "node-22", lockfileDigest: LOCK, template: "node",
      attemptKey: `${JOB}:1`, causationId: "run-1:1",
      assertCurrent: async (phase) => phase !== "checkpoint_store",
    })).rejects.toMatchObject({ code: "stale_attempt" });
    expect(checkpoint.objects.size).toBe(putsBefore);
  });

  it("validates nested source and textual patch content and keeps hot receipts payload-free", async () => {
    const source = archive([{ name: "safe.txt", data: new TextEncoder().encode("safe") }]);
    const safePatch = patch("diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-safe\n+safer\n");
    const bytes = createPortableCheckpointArchive(source, safePatch.patch);
    const manifest = {
      version: 2 as const, jobId: JOB, attempt: 1, provider: "cloudflare" as const,
      providerWorkspaceId: "workspace-1", providerSessionId: "session-1", baseSha: BASE,
      sourceArchiveSha256: source.sha256, sourceArchiveBytes: source.bytes.byteLength,
      archiveSha256: sha256Bytes(bytes), archiveBytes: bytes.byteLength, runtime: "node-22",
      lockfileDigest: LOCK, template: "node", attemptKey: `${JOB}:1`, causationId: "run-1:1", createdAt: 1,
    };
    expect(validatePortableCheckpointArchive(bytes, manifest).patch.byteCount).toBe(safePatch.byteCount);
    expect(() => createPortableCheckpointArchive(source, new Uint8Array([0]))).toThrow(/binary/);
    expect(() => createPortableCheckpointArchive(source, new TextEncoder().encode("+api_key=sk-abcdefghijklmnopqrstuvwxyz123456\n"))).toThrow(/secret-like/);
    const hotReceipt = { checkpointRef: `sandbox-checkpoints/sha256/${manifest.archiveSha256}`, checkpointDigest: manifest.archiveSha256, checkpointBytes: bytes.byteLength, checkpointManifestDigest: sha256Bytes(canonicalWorkspaceCheckpoint(manifest)), checkpointManifest: canonicalWorkspaceCheckpoint(manifest) };
    expect(JSON.stringify(hotReceipt)).not.toContain(Buffer.from(bytes).toString("base64"));
    expect(Object.values(hotReceipt as Record<string, unknown>).some((value) => value instanceof Uint8Array)).toBe(false);
  });

  it("does not advertise a production dependency cache from a test-only Map", () => {
    const source = readFileSync(join(process.cwd(), "src/trigger/cloud-workspace.ts"), "utf8");
    expect(source).not.toContain("WorkspaceLayerCache");
    expect(source).not.toContain("new Map<string, { digest: string; bytes: number }>");
  });

  it("terminates scheduled orphans without a host fallback", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const one = await provider.createWorkspace({ attemptKey: "1", template: "node", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    const two = await provider.createWorkspace({ attemptKey: "2", template: "node", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    await expect(terminateOrphanedCloudWorkspaces([{ provider, workspace: one }, { provider, workspace: two }])).resolves.toEqual({ terminated: 2, failed: 0 });
    expect(provider.isTerminated(one)).toBe(true);
    expect(provider.isTerminated(two)).toBe(true);
  });

  it("routes orphan cleanup by persisted provider identity and reports absent exact-provider credentials", () => {
    expect(() => configuredCloudWorkspaceCleanupProvider({ JARVIS_CLOUD_WORKSPACE_PROVIDER: "sandbox0", SANDBOX0_TOKEN: "configured-elsewhere" }, "e2b"))
      .toThrow(expect.objectContaining({ provider: "e2b", code: "missing_configuration" }));
    expect(() => configuredCloudWorkspaceCleanupProvider({ E2B_API_KEY: "must-not-fallback" }, "daytona"))
      .toThrow(expect.objectContaining({ provider: "daytona", code: "cleanup_blocked" }));
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    expect(runner).toContain("configuredCloudWorkspaceCleanupProvider(process.env, providerName)");
    expect(runner).toContain("jobs:noteCloudWorkspaceCleanupBlocked");
    expect(runner).not.toContain("orphans.filter((row) => row.providerName === cleanupProvider.name)");
  });

  it("reports truthful provider capability failures instead of papering them over", () => {
    expect(CLOUD_WORKSPACE_CAPABILITY_MATRIX.e2b.boundedResources).toBe(false);
    expect(CLOUD_WORKSPACE_CAPABILITY_MATRIX).not.toHaveProperty("daytona");
    expect(Object.values(CLOUD_WORKSPACE_CAPABILITY_MATRIX.cloudflare).every((value) => value === false)).toBe(true);
    const e2b = configuredCloudWorkspaceCleanupProvider({ JARVIS_CLOUD_WORKSPACE_PROVIDER: "e2b", E2B_API_KEY: "test-only" });
    expect(Object.keys(e2b).sort()).toEqual(["name", "terminate"]);
    const unprovenE2b = new FakeCloudWorkspaceProvider();
    unprovenE2b.capabilities.boundedResources = false;
    expect(() => assertRequiredCapabilities(unprovenE2b)).toThrow(/boundedResources/);
    const fake = new FakeCloudWorkspaceProvider();
    fake.capabilities.exactCommandCancellation = false;
    expect(() => assertRequiredCapabilities(fake)).toThrow(/exactCommandCancellation/);
  });

  it("contains no OpenAI API credential or model-provider path in the cloud boundary", () => {
    const files = ["cloud-agent-runner.ts", "cloud-workspace.ts", "cloud-workspace-controller.ts", "cloud-workspace-providers.ts", "cloud-workspace-tools.ts"];
    const source = files.map((file) => readFileSync(join(process.cwd(), "src/trigger", file), "utf8")).join("\n");
    expect(source).not.toMatch(/OPENAI_API_KEY|api\.openai\.com|modelProvider|managed agent/i);
    expect(source).not.toMatch(/localhost|\/home\/ubuntu|docker\s+run|child_process.*(?:exec|spawn).*repository/i);
  });

  it("connects the actual specialist caller to adapter tools and never gives Codex the controller checkout cwd", () => {
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    const specialist = runner.slice(runner.indexOf("const processJob ="), runner.indexOf("const synthesizeMissionClaim ="));
    expect(specialist).toContain("prepareCloudWorkspaceExecution");
    expect(specialist).toContain("jobs:cloudCheckpointForReplay");
    expect(specialist).toContain("replayCloudWorkspaceExecution");
    expect(specialist).toContain('recordReplayDecision("reject", "checkpoint_object_missing")');
    expect(specialist).not.toContain('recordReplayDecision("hydrate", "checkpoint_object_missing")');
    expect(readFileSync(join(process.cwd(), "src/trigger/cloud-workspace-controller.ts"), "utf8")).toContain("input.provider.recreateFromCheckpoint");
    expect(specialist).toContain("runCloudWorkspaceAgent");
    expect(specialist).toContain("controllerScratch");
    expect(specialist).toContain("applyValidatedPatchToControllerCheckout");
    expect(specialist).not.toMatch(/await runAgent\s*\(/);
    expect(runner.indexOf("configuredCloudWorkspaceProvider(process.env, options.runtimeAttestation)")).toBeLessThan(runner.indexOf("await processJob(job, cloudProvider)"));
    expect(specialist).toContain("isolateCloudSubscriptionEnv");
    expect(specialist).toContain("trusted controller checkout still exists at Codex startup");
    expect(specialist.indexOf("rmSync(repoDir, { recursive: true, force: true })")).toBeLessThan(specialist.indexOf("runCloudWorkspaceAgent({"));
  });

  it.skip("BLOCKED: real E2B lifecycle/quota probe requires a safe scoped credential and a template proving resource bounds", () => {});
  it.skip("BLOCKED: real Sandbox0 lifecycle/quota/rootfs/volume/network probe requires safe scoped beta credentials", () => {});
});
