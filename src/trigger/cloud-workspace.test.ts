import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CloudWorkspaceError,
  ContentAddressedCheckpointStore,
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceLayerCache,
  assertRequiredCapabilities,
  controllerApplyValidatedPatch,
  sha256Bytes,
  validateCredentiallessArchive,
  validatePatchManifest,
  type CredentiallessArchive,
  type PatchManifest,
} from "./cloud-workspace";
import { FakeCloudWorkspaceProvider } from "./cloud-workspace-fake";
import { CloudWorkspaceToolBridge } from "./cloud-workspace-tools";
import { prepareCloudWorkspaceExecution, terminateOrphanedCloudWorkspaces } from "./cloud-workspace-controller";
import { CLOUD_WORKSPACE_CAPABILITY_MATRIX, configuredCloudWorkspaceProvider } from "./cloud-workspace-providers";

const BASE = "a".repeat(40);

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

describe("fail-closed cloud workspace boundary", () => {
  it("runs the fake full lifecycle, same-id resume, termination, and new-id exact replay", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const source = archive([{ name: "README.md", data: new TextEncoder().encode("base") }]);
    const first = await provider.createWorkspace({ attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    await provider.uploadCredentiallessArchive(first, source);
    await provider.writeFile(first, "src/value.ts", new TextEncoder().encode("export const value = 1;"), 1_000);
    await expect(provider.exec(first, { command: "printf ready", timeoutMs: 1_000, maxOutputBytes: 1_000 })).resolves.toMatchObject({ stdout: "ready" });
    expect(provider.resume(first)).toEqual(first);
    const checkpoint = await provider.checkpoint(first, { baseSha: BASE, runtime: "node-22", lockfileDigest: "b".repeat(64), template: "node", attemptKey: "job:1", causationId: "run:1" });
    await provider.terminate(first, "terminal");
    expect(provider.isTerminated(first)).toBe(true);
    const replay = await provider.recreateFromCheckpoint({ checkpoint: checkpoint.manifest, archive: checkpoint.archive, limits: DEFAULT_WORKSPACE_LIMITS });
    expect(replay.providerWorkspaceId).not.toBe(first.providerWorkspaceId);
    expect(replay.providerSessionId).not.toBe(first.providerSessionId);
    expect(sha256Bytes(checkpoint.archive)).toBe(checkpoint.manifest.archiveSha256);
    expect(provider.calls).toEqual(expect.arrayContaining(["createWorkspace", "uploadCredentiallessArchive", "exec", "checkpoint", "terminate:terminal", "recreateFromCheckpoint"]));
  });

  it("resolves missing configuration before hydration and therefore before host spawn", async () => {
    const hydrate = vi.fn(async () => archive([{ name: "safe.txt", data: new TextEncoder().encode("safe") }]));
    await expect(prepareCloudWorkspaceExecution({
      providerFactory: () => configuredCloudWorkspaceProvider({}),
      hydrateArchive: hydrate,
      attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64),
    })).rejects.toMatchObject({ code: "missing_configuration" });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("never projects controller secrets or caller env into sandbox execution", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    const bridge = new CloudWorkspaceToolBridge(provider, workspace);
    await bridge.invoke({ threadId: "t", turnId: "r", callId: "c", namespace: null, tool: "repository_exec", arguments: { command: "printf clean" } });
    expect(provider.observedExecEnvironments).toEqual([{}]);
    expect(JSON.stringify(provider.observedExecEnvironments)).not.toMatch(/OPENAI|CODEX|GITHUB|CONVEX|TRIGGER|VAULT|TOKEN|SECRET/);
  });

  it.each([
    ["traversal", { name: "../escape", type: "0" }],
    ["absolute", { name: "/etc/passwd", type: "0" }],
    ["symlink", { name: "link", type: "2" }],
    ["hardlink", { name: "link", type: "1" }],
    ["character device", { name: "device", type: "3" }],
    ["block device", { name: "device", type: "4" }],
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
      async (key) => objects.get(key)?.slice() ?? new Uint8Array(),
    );
    const bytes = new TextEncoder().encode("checkpoint");
    const provider = new FakeCloudWorkspaceProvider();
    const workspace = await provider.createWorkspace({ attemptKey: "job:1", template: "node", runtime: "node-22", lockfileDigest: "b".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    const manifest = (await provider.checkpoint(workspace, { baseSha: BASE, runtime: "node-22", lockfileDigest: "b".repeat(64), template: "node", attemptKey: "job:1", causationId: "run:1" })).manifest;
    const fixed = { ...manifest, archiveSha256: sha256Bytes(bytes), archiveBytes: bytes.byteLength };
    const stored = await store.put(fixed, bytes);
    await expect(store.get(stored.ref, stored.digest, stored.byteCount)).resolves.toEqual(bytes);
    objects.set(stored.ref, new TextEncoder().encode("tampered"));
    await expect(store.get(stored.ref, stored.digest, stored.byteCount)).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("isolates dependency caches by project, tenant, runtime, and exact lockfile digest", () => {
    const cache = new WorkspaceLayerCache();
    const first = cache.key("jarvis", "daniel", "node-22", "a".repeat(64));
    const otherProject = cache.key("finance-engine-v2", "daniel", "node-22", "a".repeat(64));
    const otherTenant = cache.key("jarvis", "other", "node-22", "a".repeat(64));
    expect(new Set([first, otherProject, otherTenant]).size).toBe(3);
    expect(cache.lookup(first)).toBeNull();
    cache.populate(first, "b".repeat(64), 123);
    expect(cache.lookup(first)).toEqual({ digest: "b".repeat(64), bytes: 123 });
    expect(cache.lookup(otherProject)).toBeNull();
    cache.recordCold(800); cache.recordWarm(90);
    expect(cache.telemetry).toMatchObject({ misses: 2, hits: 1, coldMs: 800, warmMs: 90, bytes: 123 });
  });

  it("terminates scheduled orphans without a host fallback", async () => {
    const provider = new FakeCloudWorkspaceProvider();
    const one = await provider.createWorkspace({ attemptKey: "1", template: "node", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    const two = await provider.createWorkspace({ attemptKey: "2", template: "node", runtime: "node-22", lockfileDigest: "a".repeat(64), limits: DEFAULT_WORKSPACE_LIMITS });
    await expect(terminateOrphanedCloudWorkspaces([{ provider, workspace: one }, { provider, workspace: two }])).resolves.toEqual({ terminated: 2, failed: 0 });
    expect(provider.isTerminated(one)).toBe(true);
    expect(provider.isTerminated(two)).toBe(true);
  });

  it("reports truthful provider capability failures instead of papering them over", () => {
    expect(CLOUD_WORKSPACE_CAPABILITY_MATRIX.e2b.boundedResources).toBe(false);
    expect(CLOUD_WORKSPACE_CAPABILITY_MATRIX.daytona).toMatchObject({
      boundedResources: false,
      exactCommandCancellation: false,
    });
    expect(Object.values(CLOUD_WORKSPACE_CAPABILITY_MATRIX.cloudflare).every((value) => value === false)).toBe(true);
    expect(() => configuredCloudWorkspaceProvider({ JARVIS_CLOUD_WORKSPACE_PROVIDER: "e2b", E2B_API_KEY: "test-only" })).toThrow(/boundedResources/);
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
    expect(specialist).toContain("runCloudWorkspaceAgent");
    expect(specialist).toContain("controllerScratch");
    expect(specialist).toContain("applyValidatedPatchToControllerCheckout");
    expect(specialist).not.toMatch(/await runAgent\s*\(/);
    expect(runner.indexOf("configuredCloudWorkspaceProvider(process.env)")).toBeLessThan(runner.indexOf("await processJob(job, cloudProvider)"));
    expect(specialist).toContain("isolateCloudSubscriptionEnv");
    expect(specialist).toContain("trusted controller checkout still exists at Codex startup");
    expect(specialist.indexOf("rmSync(repoDir, { recursive: true, force: true })")).toBeLessThan(specialist.indexOf("runCloudWorkspaceAgent({"));
  });

  it.skip("BLOCKED: real E2B lifecycle/quota probe requires a safe scoped credential and a template proving resource bounds", () => {});
  it.skip("BLOCKED: real Daytona lifecycle/quota/snapshot/volume/secret probe requires safe scoped managed-cloud credentials", () => {});
  it.skip("BLOCKED: real Sandbox0 lifecycle/quota/rootfs/volume/network probe requires safe scoped beta credentials", () => {});
});
