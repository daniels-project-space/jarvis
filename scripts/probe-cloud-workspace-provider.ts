import { randomBytes, randomUUID } from "node:crypto";
import {
  CLOUD_PROVIDER_PROBE_MAX_AGE_MS,
  cloudProviderTemplateDigest,
  configuredCloudProviderProbeBinding,
  configuredCloudProviderProbeKeyring,
  installedCloudProviderSdkVersion,
  type CloudProviderProbeReceipt,
} from "../src/trigger/cloud-provider-probe-attestation";
import {
  DEFAULT_WORKSPACE_LIMITS,
  REQUIRED_CLOUD_WORKSPACE_CAPABILITIES,
  sha256Bytes,
  type CloudWorkspace,
} from "../src/trigger/cloud-workspace";
import { configuredCloudWorkspaceProviderForLiveProbe } from "../src/trigger/cloud-workspace-providers";
import {
  cloudWorkspaceCancellationProbeRemote,
  issueAfterExactRemoteCancellation,
  probeExactRemoteCancellation,
} from "../src/trigger/cloud-provider-cancellation-probe";

const LIVE_OPT_IN = "JARVIS_CLOUD_PROVIDER_PROBE=live";

function blocked(reason: string): never {
  console.log(`BLOCKED: ${reason}; no provider probe receipt was emitted`);
  process.exit(2);
}

function configuredCredentialAvailable(env: NodeJS.ProcessEnv): boolean {
  if (env.JARVIS_CLOUD_WORKSPACE_PROVIDER === "sandbox0") return Boolean(env.SANDBOX0_TOKEN);
  if (env.JARVIS_CLOUD_WORKSPACE_PROVIDER === "e2b") return Boolean(env.E2B_API_KEY);
  if (env.JARVIS_CLOUD_WORKSPACE_PROVIDER === "daytona") return Boolean(env.DAYTONA_API_KEY);
  return false;
}

function probeArchive(): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  const data = encoder.encode("provider-probe\n");
  header.set(encoder.encode("PROBE.txt"), 0);
  header.set(encoder.encode("0000644\0"), 100);
  header.set(encoder.encode("0000000\0"), 108);
  header.set(encoder.encode("0000000\0"), 116);
  header.set(encoder.encode(data.byteLength.toString(8).padStart(11, "0") + "\0"), 124);
  header.set(encoder.encode("00000000000\0"), 136);
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
  return Buffer.concat([header, data, new Uint8Array(512 - data.byteLength), new Uint8Array(1024)]);
}

function finiteQuota(value: { unlimited?: boolean; limitValue?: number | null; remaining?: number | null } | undefined): boolean {
  return Boolean(value && value.unlimited === false && Number(value.limitValue) > 0 && Number(value.remaining) >= 0);
}

function parseBounds(stdout: string): { cpu: number; memoryMb: number } {
  const cpu = stdout.match(/CPU=(\d+)\s+(\d+)/);
  const memory = stdout.match(/MEM=(\d+)/);
  if (!cpu || !memory) throw new Error("bounded cgroup observations unavailable");
  const cpuCount = Number(cpu[1]) / Number(cpu[2]);
  const memoryMb = Number(memory[1]) / (1024 * 1024);
  if (!Number.isFinite(cpuCount) || !Number.isFinite(memoryMb)) throw new Error("bounded cgroup observations malformed");
  return { cpu: cpuCount, memoryMb };
}

async function inspectSandbox0Configuration(workspace: CloudWorkspace, templateIdentity: string, expectedTemplateDigest: string) {
  const { Client: Sandbox0Client } = await import("sandbox0");
  const client = new Sandbox0Client({ token: process.env.SANDBOX0_TOKEN!, baseUrl: process.env.SANDBOX0_BASE_URL });
  const template = await client.templates.get(templateIdentity);
  const actualTemplateDigest = cloudProviderTemplateDigest({ templateId: template.templateId, spec: template.spec });
  if (actualTemplateDigest !== expectedTemplateDigest) throw new Error("configured template digest does not match live provider provenance");
  const detail = await client.sandboxes.get(workspace.providerWorkspaceId);
  const network = await client.sandbox(workspace.providerWorkspaceId).getNetworkPolicy();
  const quotas = await client.quotas.list();
  const quota = (dimension: string) => quotas.find((entry) => entry.dimension === dimension);
  if (detail.templateId !== template.templateId) throw new Error("claimed sandbox template identity changed");
  if (detail.autoResume || (detail.services ?? []).some((service) => service.ingress?._public)) throw new Error("private ingress was not preserved");
  if (network.mode !== "block-all" || (network.credentialBindings ?? []).length !== 0) throw new Error("network deny policy was not committed");
  const ttlMs = detail.expiresAt.getTime() - detail.claimedAt.getTime();
  if (!(ttlMs > 0 && ttlMs <= DEFAULT_WORKSPACE_LIMITS.ttlMs)) throw new Error("provider TTL was not bounded");
  const observedMemory = Number(String(detail.resources?.memory ?? "").match(/^(\d+)Mi$/)?.[1]);
  if (!(observedMemory > 0 && observedMemory <= DEFAULT_WORKSPACE_LIMITS.memoryMb)) throw new Error("provider memory bound was not committed");
  if (!finiteQuota(quota("cpu_millicpu")) || !finiteQuota(quota("memory_mib")) || !finiteQuota(quota("active_sandboxes"))) {
    throw new Error("finite lifecycle quotas were not observable");
  }
  return { ttlMs, observedMemory };
}

async function main() {
  if (process.env.JARVIS_CLOUD_PROVIDER_PROBE !== "live") blocked(`real live opt-in is required (${LIVE_OPT_IN})`);
  if (!configuredCredentialAvailable(process.env)) blocked("a safe scoped credential for the selected provider is unavailable");

  let binding;
  let authority;
  try {
    binding = configuredCloudProviderProbeBinding(process.env);
    authority = configuredCloudProviderProbeKeyring(process.env);
  } catch {
    blocked("the exact deployment/template provenance configuration is incomplete");
  }
  if (!authority) blocked("the rotating controller-only receipt signer is unavailable");
  if (binding.provider !== "sandbox0") blocked("the selected pinned adapter cannot exercise every required live capability");
  if (installedCloudProviderSdkVersion(binding.provider) !== binding.sdk.version) blocked("the installed provider SDK does not match the pinned tuple");

  const provider = configuredCloudWorkspaceProviderForLiveProbe(process.env);
  const runId = `provider-probe-${randomUUID()}`;
  const attemptKey = runId;
  let first: CloudWorkspace | null = null;
  let recreated: CloudWorkspace | null = null;
  try {
    first = await provider.createWorkspace({
      attemptKey,
      template: binding.template.identity,
      runtime: binding.runtime.identity,
      lockfileDigest: binding.runtime.digest,
      limits: DEFAULT_WORKSPACE_LIMITS,
    });
    const providerObservation = await inspectSandbox0Configuration(first, binding.template.identity, binding.template.digest);

    const bytes = probeArchive();
    await provider.uploadCredentiallessArchive(first, { baseSha: "0".repeat(40), sha256: sha256Bytes(bytes), bytes });
    const envResult = await provider.exec(first, {
      command: "node -e 'process.stdout.write(JSON.stringify(process.env))'",
      cwd: first.root,
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
    });
    if (envResult.exitCode !== 0) throw new Error("environment probe failed");
    const sandboxEnv = JSON.parse(envResult.stdout) as Record<string, string>;
    const controllerCanary = String(process.env.JARVIS_CLOUD_PROVIDER_PROBE_SECRET_CANARY ?? "controller-secret-canary-not-configured");
    if (Object.keys(sandboxEnv).some((key) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|CODEX|GITHUB|CONVEX|TRIGGER|VAULT)/i.test(key))) {
      throw new Error("sandbox environment contains an authority-shaped name");
    }
    if (Object.values(sandboxEnv).some((value) => value.includes(controllerCanary))) throw new Error("controller canary reached the sandbox");

    const boundsResult = await provider.exec(first, {
      command: "sh -lc 'printf \"CPU=\"; cat /sys/fs/cgroup/cpu.max; printf \"\\nMEM=\"; cat /sys/fs/cgroup/memory.max'",
      cwd: first.root,
      timeoutMs: 30_000,
      maxOutputBytes: 4_000,
    });
    if (boundsResult.exitCode !== 0) throw new Error("resource observation failed");
    const bounds = parseBounds(boundsResult.stdout);
    if (bounds.cpu > DEFAULT_WORKSPACE_LIMITS.cpu || bounds.memoryMb > DEFAULT_WORKSPACE_LIMITS.memoryMb) {
      throw new Error("observed resources exceed the controller bounds");
    }

    const networkResult = await provider.exec(first, {
      command: "node -e 'fetch(\"https://example.com\",{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(9),()=>process.exit(0))'",
      cwd: first.root,
      timeoutMs: 10_000,
      maxOutputBytes: 4_000,
    });
    if (networkResult.exitCode !== 0) throw new Error("network deny behavioral probe failed");

    const cancellationEvidence = await probeExactRemoteCancellation(
      cloudWorkspaceCancellationProbeRemote(provider, first),
      runId,
    );

    await provider.writeFile(first, "probe-identity.txt", new TextEncoder().encode(runId), 4_000);
    const checkpoint = await provider.checkpoint(first, {
      jobId: runId, attempt: 1,
      baseSha: "0".repeat(40), runtime: binding.runtime.identity, lockfileDigest: binding.runtime.digest,
      sourceArchiveSha256: sha256Bytes(bytes), sourceArchiveBytes: bytes.byteLength,
      template: binding.template.identity, attemptKey, causationId: runId,
    });
    await provider.terminate(first, "terminal");
    const terminatedFirst = first;
    first = null;
    recreated = await provider.recreateFromCheckpoint({
      checkpoint: checkpoint.manifest,
      archive: checkpoint.archive,
      limits: DEFAULT_WORKSPACE_LIMITS,
      attemptKey: `${runId}:2`,
    });
    if (recreated.providerWorkspaceId === terminatedFirst.providerWorkspaceId || recreated.providerSessionId === terminatedFirst.providerSessionId) {
      throw new Error("recreated sandbox identity did not change");
    }
    const marker = new TextDecoder().decode(await provider.readFile(recreated, "probe-identity.txt", 4_000));
    if (marker !== runId) throw new Error("portable checkpoint replay identity failed");
    await provider.terminate(recreated, "terminal");
    recreated = null;

    const probeTime = Date.now();
    const receipt: CloudProviderProbeReceipt = {
      schemaVersion: 1,
      ...binding,
      exercisedCapabilities: [...REQUIRED_CLOUD_WORKSPACE_CAPABILITIES],
      observed: {
        cpu: bounds.cpu,
        memoryMb: providerObservation.observedMemory,
        ttlMs: providerObservation.ttlMs,
        quota: { cpu: true, memory: true, activeSandboxes: true },
        privateIngress: true,
        emptyEnvironment: true,
        networkDeny: true,
        exactCancellation: true,
        lifecycle: { create: true, exec: true, checkpoint: true, terminate: true, recreate: true, identityChanged: true },
      },
      probeTime,
      expiresAt: probeTime + Math.min(6 * 60 * 60_000, CLOUD_PROVIDER_PROBE_MAX_AGE_MS),
      runId,
      nonce: randomBytes(24).toString("base64url"),
    };
    const envelope = issueAfterExactRemoteCancellation(cancellationEvidence, () => authority.issue(receipt));
    console.log(JSON.stringify({ status: "PASS", envelope }));
  } catch {
    if (recreated) await provider.terminate(recreated, "orphan").catch(() => undefined);
    if (first) await provider.terminate(first, "orphan").catch(() => undefined);
    blocked("one or more required live provider lifecycle, quota, isolation, or provenance checks failed");
  }
}

void main().catch(() => blocked("the live provider probe could not complete"));
