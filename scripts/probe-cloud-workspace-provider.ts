import { randomBytes, randomUUID } from "node:crypto";
import { runWithDeadline } from "../src/lib/bounded-json";
import {
  cloudProviderTemplateDigest,
  configuredCloudProviderProbeBinding,
  configuredCloudProviderProbeKeyring,
  installedCloudProviderSdkVersion,
  type CloudProviderProbeReceipt,
} from "../src/trigger/cloud-provider-probe-attestation";
import { cloudProviderProbeMaxAgeMs } from "../src/lib/cloud-provider-probe-policy";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  REQUIRED_CLOUD_WORKSPACE_CAPABILITIES,
  createDeterministicTar,
  sha256Bytes,
  type CloudWorkspace,
} from "../src/trigger/cloud-workspace";
import {
  assertVercelPlanAuthorized,
  configuredCloudWorkspaceProviderForLiveProbe,
  isVercelProSpendApproved,
  VERCEL_ACTIVE_SANDBOX_CAP,
  VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE,
  VERCEL_HISTORY_PAGE_CEILING,
  VERCEL_HISTORY_PAGE_LIMIT,
  VERCEL_HISTORY_TOTAL_CEILING,
  VERCEL_NAME_PREFIX,
} from "../src/trigger/cloud-workspace-providers";
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
  if (env.JARVIS_CLOUD_WORKSPACE_PROVIDER === "vercel") return Boolean(env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID);
  return false;
}

function probeArchive(): Uint8Array {
  const encoder = new TextEncoder();
  // The empty dependency graph still exercises the Vercel adapter's exact
  // allow-only npm policy transition, cleanup, relock, and deny probe without
  // downloading a package or relying on a package-manager script.
  return createDeterministicTar([
    { path: "PROBE.txt", data: encoder.encode("provider-probe\n") },
    { path: "package.json", data: encoder.encode('{"name":"jarvis-provider-probe","version":"0.0.0","private":true}') },
    { path: "package-lock.json", data: encoder.encode('{"name":"jarvis-provider-probe","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"jarvis-provider-probe","version":"0.0.0"}}}') },
  ]);
}

function finiteQuota(value: { unlimited?: boolean; limitValue?: number | null; remaining?: number | null } | undefined): boolean {
  return Boolean(value && value.unlimited === false && Number(value.limitValue) > 0 && Number(value.remaining) >= 0);
}

function parseBounds(stdout: string): { cpu: number; memoryMb: number } {
  const cpu = stdout.match(/CPU=(\d+)(?:\s+(\d+))?/);
  const memory = stdout.match(/MEM=(\d+)/);
  if (!cpu || !memory) throw new Error("bounded resource observations unavailable");
  const cpuCount = cpu[2] ? Number(cpu[1]) / Number(cpu[2]) : Number(cpu[1]);
  const memoryMb = Number(memory[1]) / (1024 * 1024);
  if (!(cpuCount > 0) || !(memoryMb > 0) || !Number.isFinite(cpuCount) || !Number.isFinite(memoryMb)) {
    throw new Error("bounded resource observations malformed");
  }
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

async function inspectVercelConfiguration(workspace: CloudWorkspace): Promise<{ ttlMs: number; observedMemory: number }> {
  const { Sandbox } = await import("@vercel/sandbox");
  const credentials = { token: process.env.VERCEL_TOKEN!, teamId: process.env.VERCEL_TEAM_ID!, projectId: process.env.VERCEL_PROJECT_ID! };
  // This is deliberately a fresh, no-resume observation rather than cached
  // adapter metadata. A stopped or substituted session is not proof.
  const detail = await runWithDeadline(30_000, async (signal) =>
    await Sandbox.get({ ...credentials, name: workspace.providerWorkspaceId, resume: false, signal }));
  const session = detail.currentSession();
  if (detail.name !== workspace.providerWorkspaceId || session.sessionId !== workspace.providerSessionId || session.status !== "running") {
    throw new Error("exact Vercel Sandbox name/session observation changed");
  }
  if (detail.runtime !== VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.runtime
    || detail.vcpus !== VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.vcpus
    || detail.memory !== VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.memoryMb
    || detail.routes.length !== VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.portCount
    || detail.persistent !== false || detail.networkPolicy !== "deny-all" || session.networkPolicy !== "deny-all"
    || !detail.expiresAt || detail.expiresAt.getTime() <= Date.now()
    || detail.expiresAt.getTime() - detail.createdAt.getTime() > VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE.ttlMs) {
    throw new Error("Vercel runtime, private ingress, deny policy, persistence, or TTL observation failed");
  }
  let active = 0; let named = false; let pages = 0; let total = 0; let complete = false;
  await runWithDeadline(30_000, async (signal) => {
    const listed = await Sandbox.list({
      ...credentials,
      namePrefix: VERCEL_NAME_PREFIX,
      sortBy: "name",
      sortOrder: "asc",
      tags: { owner: "jarvis" },
      limit: VERCEL_HISTORY_PAGE_LIMIT,
      signal,
    });
    // Page metadata gives the finite completeness proof for all owner-scoped
    // attempts, and one abort signal remains live across every next-page fetch.
    for await (const page of listed.pages()) {
      pages += 1;
      total += page.sandboxes.length;
      if (pages > VERCEL_HISTORY_PAGE_CEILING || total > VERCEL_HISTORY_TOTAL_CEILING) {
        throw new Error("Vercel Sandbox history exceeds the bounded controller enumeration ceiling");
      }
      for (const item of page.sandboxes) {
        if (item.name === workspace.providerWorkspaceId && item.currentSessionId === workspace.providerSessionId) named = true;
        if (["pending", "running", "snapshotting", "stopping"].includes(item.status)) active += 1;
        if (active > VERCEL_ACTIVE_SANDBOX_CAP) throw new Error("Vercel project-scoped controller active-sandbox cap was exceeded");
      }
      if (page.pagination.next === null) { complete = true; break; }
      if (pages === VERCEL_HISTORY_PAGE_CEILING) {
        throw new Error("Vercel Sandbox history completeness cannot be proved within the controller page ceiling");
      }
    }
  });
  if (!complete) throw new Error("Vercel Sandbox history completeness could not be proved");
  if (!named) throw new Error("exact named Vercel Sandbox was absent from provider list observation");
  // Account billing state is independently checked through the authoritative
  // team API before creation and again immediately before receipt issuance.
  return { ttlMs: detail.expiresAt.getTime() - detail.createdAt.getTime(), observedMemory: detail.memory };
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
  if (binding.provider !== "sandbox0" && binding.provider !== "vercel") blocked("the selected pinned adapter cannot exercise every required live capability");
  if (installedCloudProviderSdkVersion(binding.provider) !== binding.sdk.version) blocked("the installed provider SDK does not match the pinned tuple");
  if (binding.provider === "vercel"
    && binding.template.digest !== cloudProviderTemplateDigest(VERCEL_CLOUD_WORKSPACE_TEMPLATE_PROVENANCE)) {
    blocked("the Vercel template digest does not match the exact bounded runtime policy");
  }

  const provider = configuredCloudWorkspaceProviderForLiveProbe(process.env);
  const runId = `provider-probe-${randomUUID()}`;
  const attemptKey = runId;
  let first: CloudWorkspace | null = null;
  let recreated: CloudWorkspace | null = null;
  let probeStage = "workspace creation";
  let safeFailureDetail = "";
  try {
    first = await provider.createWorkspace({
      attemptKey,
      template: binding.template.identity,
      runtime: binding.runtime.identity,
      lockfileDigest: binding.runtime.digest,
      limits: DEFAULT_WORKSPACE_LIMITS,
      onStage: async (stage) => { probeStage = `workspace creation:${stage}`; },
    });
    probeStage = "provider configuration observation";
    let providerObservation = binding.provider === "sandbox0"
      ? await inspectSandbox0Configuration(first, binding.template.identity, binding.template.digest)
      : await inspectVercelConfiguration(first);

    const bytes = probeArchive();
    probeStage = "credentialless archive upload";
    await provider.uploadCredentiallessArchive(first, { baseSha: "0".repeat(40), sha256: sha256Bytes(bytes), bytes });
    if (binding.provider === "vercel") {
      if (!provider.hydrateDependencies) throw new Error("Vercel dependency lifecycle adapter is unavailable");
      probeStage = "dependency hydration and relock";
      await provider.hydrateDependencies(first);
      // Re-fetch after the allow-only install phase. This is an authoritative
      // provider observation of the relock, not a copy of controller intent.
      providerObservation = await inspectVercelConfiguration(first);
    }
    // This reads the uploaded provider file through the fenced data plane;
    // it proves the exact sandbox's file lifecycle rather than inferring it
    // from the configured archive.
    probeStage = "uploaded file readback";
    if (new TextDecoder().decode(await provider.readFile(first, "PROBE.txt", 4_000)) !== "provider-probe\n") {
      throw new Error("provider file lifecycle observation failed");
    }
    probeStage = "empty environment observation";
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

    probeStage = "resource bound observation";
    // Vercel applies the configured limit at the microVM boundary, where the
    // nested guest cgroup legitimately reports `max`. Observe the guest's
    // allocated CPU/memory there; Sandbox0 exposes container cgroup quotas.
    const resourceCommand = binding.provider === "vercel"
      ? "node -e 'const os=require(\"node:os\");process.stdout.write(\"CPU=\"+os.availableParallelism()+\"\\nMEM=\"+os.totalmem())'"
      : "sh -lc 'printf \"CPU=\"; cat /sys/fs/cgroup/cpu.max; printf \"\\nMEM=\"; cat /sys/fs/cgroup/memory.max'";
    const boundsResult = await provider.exec(first, {
      command: resourceCommand,
      cwd: first.root,
      timeoutMs: 30_000,
      maxOutputBytes: 4_000,
    });
    if (boundsResult.exitCode !== 0) {
      safeFailureDetail = ` (resource command exit ${boundsResult.exitCode})`;
      throw new Error("resource observation failed");
    }
    let bounds: { cpu: number; memoryMb: number };
    try {
      bounds = parseBounds(boundsResult.stdout);
    } catch {
      safeFailureDetail = ` (resource output ${JSON.stringify(boundsResult.stdout.slice(0, 160))})`;
      throw new Error("resource observation malformed");
    }
    const memoryUpperBound = binding.provider === "vercel"
      // Guest total memory includes a small VM/kernel accounting delta around
      // the independently observed 4,096 MiB provider allocation.
      ? providerObservation.observedMemory * 1.1
      : DEFAULT_WORKSPACE_LIMITS.memoryMb;
    if (bounds.cpu > DEFAULT_WORKSPACE_LIMITS.cpu || bounds.memoryMb > memoryUpperBound) {
      safeFailureDetail = ` (observed cpu=${bounds.cpu}, memoryMb=${Math.round(bounds.memoryMb)})`;
      throw new Error("observed resources exceed the controller bounds");
    }

    probeStage = "network deny observation";
    const networkResult = await provider.exec(first, {
      command: "node -e 'fetch(\"https://example.com\",{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(9),()=>process.exit(0))'",
      cwd: first.root,
      timeoutMs: 10_000,
      maxOutputBytes: 4_000,
    });
    if (networkResult.exitCode !== 0) throw new Error("network deny behavioral probe failed");

    probeStage = "exact cancellation observation";
    const cancellationEvidence = await probeExactRemoteCancellation(
      cloudWorkspaceCancellationProbeRemote(provider, first),
      runId,
    );

    probeStage = "checkpoint marker write";
    await provider.writeFile(first, "probe-identity.txt", new TextEncoder().encode(runId), 4_000);
    if (binding.provider === "vercel") {
      probeStage = "controller source archive preservation";
      const preservedSource = await provider.readFile(
        first,
        `.jarvis-controller-${first.providerWorkspaceId}/source.tar`,
        bytes.byteLength,
      );
      if (sha256Bytes(preservedSource) !== sha256Bytes(bytes)) {
        throw new Error("controller source archive changed before checkpoint");
      }
    }
    probeStage = "portable checkpoint creation";
    const checkpoint = await provider.checkpoint(first, {
      jobId: runId, attempt: 1,
      baseSha: "0".repeat(40), runtime: binding.runtime.identity, lockfileDigest: binding.runtime.digest,
      sourceArchiveSha256: sha256Bytes(bytes), sourceArchiveBytes: bytes.byteLength,
      template: binding.template.identity, attemptKey, causationId: runId,
    });
    probeStage = "first workspace termination";
    await provider.terminate(first, "terminal");
    const terminatedFirst = first;
    first = null;
    probeStage = "portable checkpoint recreation";
    recreated = await provider.recreateFromCheckpoint({
      checkpoint: checkpoint.manifest,
      archive: checkpoint.archive,
      limits: DEFAULT_WORKSPACE_LIMITS,
      attemptKey: `${runId}:2`,
    });
    if (recreated.providerWorkspaceId === terminatedFirst.providerWorkspaceId || recreated.providerSessionId === terminatedFirst.providerSessionId) {
      throw new Error("recreated sandbox identity did not change");
    }
    probeStage = "portable checkpoint readback";
    const marker = new TextDecoder().decode(await provider.readFile(recreated, "probe-identity.txt", 4_000));
    if (marker !== runId) throw new Error("portable checkpoint replay identity failed");
    probeStage = "recreated workspace termination";
    await provider.terminate(recreated, "terminal");
    recreated = null;

    // Re-observe the active plan and deliberate paid-plan authorization after
    // the full lifecycle, rather than relying on a pre-create observation.
    if (binding.provider === "vercel") {
      probeStage = "final plan authorization observation";
      await runWithDeadline(30_000, (signal) => assertVercelPlanAuthorized(
        process.env.VERCEL_TOKEN!,
        process.env.VERCEL_TEAM_ID!,
        isVercelProSpendApproved(process.env.JARVIS_VERCEL_PRO_SPEND_APPROVED),
        signal,
      ));
    }

    probeStage = "signed receipt issuance";
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
      expiresAt: probeTime + (binding.provider === "vercel"
        ? cloudProviderProbeMaxAgeMs(binding.provider)
        : Math.min(6 * 60 * 60_000, cloudProviderProbeMaxAgeMs(binding.provider))),
      runId,
      nonce: randomBytes(24).toString("base64url"),
    };
    const envelope = issueAfterExactRemoteCancellation(cancellationEvidence, () => authority.issue(receipt));
    console.log(JSON.stringify({ status: "PASS", envelope }));
  } catch (error) {
    if (!safeFailureDetail && error instanceof CloudWorkspaceError) {
      safeFailureDetail = ` (${error.code}/${error.disposition}: ${error.message})`;
    } else if (!safeFailureDetail && error instanceof Error && [
      "exact remote command cancellation was not independently observed",
      "cloud provider probe receipt is malformed or partial",
      "remote cancellation probe cleanup failed",
    ].includes(error.message)) {
      // These are static protocol failures, safe to surface for an operator;
      // provider responses and credentials must remain undisclosed.
      safeFailureDetail = ` (${error.message})`;
    }
    if (recreated) await provider.terminate(recreated, "orphan").catch(() => undefined);
    if (first) await provider.terminate(first, "orphan").catch(() => undefined);
    blocked(`live provider lifecycle or safety proof failed at ${probeStage}${safeFailureDetail}`);
  }
}

void main().catch(() => blocked("the live provider probe could not complete"));
