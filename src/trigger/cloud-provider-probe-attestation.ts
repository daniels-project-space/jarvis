import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  REQUIRED_CLOUD_WORKSPACE_CAPABILITIES,
  type CloudWorkspaceProviderName,
} from "./cloud-workspace";
import { configuredCloudWorkspaceProviderName } from "../lib/cloud-provider-selection";
import { cloudProviderProbeMaxAgeMs } from "../lib/cloud-provider-probe-policy";

export const CLOUD_PROVIDER_PROBE_SCHEMA_VERSION = 1;
export { CLOUD_PROVIDER_PROBE_MAX_AGE_MS } from "../lib/cloud-provider-probe-policy";
export const CLOUD_WORKSPACE_RUNTIME_IDENTITY = "node-22:codex-0.144.5";
export const DEFAULT_CLOUD_WORKSPACE_TEMPLATE = "node22-codex-0.144.5";

export const CLOUD_PROVIDER_SDKS = Object.freeze({
  e2b: { package: "e2b", version: "2.35.0" },
  sandbox0: { package: "sandbox0", version: "0.9.3" },
  vercel: { package: "@vercel/sandbox", version: "2.8.0" },
  cloudflare: { package: "cloudflare-sandbox-compatible", version: "unconfigured" },
} as const satisfies Record<CloudWorkspaceProviderName, { package: string; version: string }>);

type RequiredCapability = typeof REQUIRED_CLOUD_WORKSPACE_CAPABILITIES[number];

export type CloudProviderProbeReceipt = Readonly<{
  schemaVersion: typeof CLOUD_PROVIDER_PROBE_SCHEMA_VERSION;
  provider: CloudWorkspaceProviderName;
  deploymentId: string;
  sdk: Readonly<{ package: string; version: string }>;
  template: Readonly<{ identity: string; digest: string }>;
  runtime: Readonly<{ identity: string; digest: string }>;
  exercisedCapabilities: readonly RequiredCapability[];
  observed: Readonly<{
    cpu: number;
    memoryMb: number;
    ttlMs: number;
    quota: Readonly<{ cpu: true; memory: true; activeSandboxes: true }>;
    privateIngress: true;
    emptyEnvironment: true;
    networkDeny: true;
    exactCancellation: true;
    lifecycle: Readonly<{
      create: true;
      exec: true;
      checkpoint: true;
      terminate: true;
      recreate: true;
      identityChanged: true;
    }>;
  }>;
  probeTime: number;
  expiresAt: number;
  runId: string;
  nonce: string;
}>;

export type CloudProviderProbeEnvelope = Readonly<{
  keyId: string;
  receipt: CloudProviderProbeReceipt;
  signature: string;
}>;

export type CloudProviderProbeBinding = Readonly<{
  provider: CloudWorkspaceProviderName;
  deploymentId: string;
  sdk: Readonly<{ package: string; version: string }>;
  template: Readonly<{ identity: string; digest: string }>;
  runtime: Readonly<{ identity: string; digest: string }>;
}>;

/** Controller-only proof copied from the Trigger SDK task run context. */
export type CloudProviderRuntimeAttestation = Readonly<{
  triggerDeploymentVersion: string | null | undefined;
}>;

export type CloudProviderProbeKey = Readonly<{ keyId: string; secret: Uint8Array | string }>;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,200}$/;
const UNVERSIONED_DEPLOYMENT = /(?:^(?:dev|development|staging|prod|production)$|(?:^|[._:/-])(?:unversioned|unknown|latest|current)(?:$|[._:/-]))/i;
const KEY_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const RECEIPT_KEYS = [
  "schemaVersion", "provider", "deploymentId", "sdk", "template", "runtime",
  "exercisedCapabilities", "observed", "probeTime", "expiresAt", "runId", "nonce",
].sort();

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

/** Stable JSON with sorted object keys; arrays retain their security-significant order. */
export function canonicalProviderProbeJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("provider probe receipt contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalProviderProbeJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalProviderProbeJson(value[key])}`).join(",")}}`;
  }
  throw new Error("provider probe receipt contains a non-JSON value");
}

export function cloudProviderTemplateDigest(value: unknown): string {
  return createHash("sha256").update(canonicalProviderProbeJson(value)).digest("hex");
}

export function cloudProviderRuntimeDigest(runtimeIdentity: string, templateDigest: string): string {
  return createHash("sha256").update(canonicalProviderProbeJson({ runtimeIdentity, templateDigest })).digest("hex");
}

function selectedProvider(env: Readonly<Record<string, string | undefined>>): CloudWorkspaceProviderName {
  const value = configuredCloudWorkspaceProviderName(env);
  if (value) return value;
  throw new CloudWorkspaceError("cloudflare", "missing_configuration", "No complete managed cloud workspace configuration is available");
}

function nonemptySafe(value: string | undefined, label: string, provider: CloudWorkspaceProviderName): string {
  const normalized = String(value ?? "").trim();
  if (!SAFE_ID.test(normalized)) {
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", `${label} is missing or malformed`, "blocked");
  }
  return normalized;
}

/** Authoring binding: the explicit live probe names the already-created target. */
export function configuredCloudProviderProbeBinding(
  env: Readonly<Record<string, string | undefined>>,
): CloudProviderProbeBinding {
  const provider = selectedProvider(env);
  const deploymentId = nonemptySafe(env.JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID, "cloud provider deployment identity", provider);
  const identity = String(env.JARVIS_CLOUD_WORKSPACE_TEMPLATE ?? DEFAULT_CLOUD_WORKSPACE_TEMPLATE).trim();
  if (!identity || identity.length > 240) {
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", "cloud workspace template identity is missing or malformed", "blocked");
  }
  const digest = String(env.JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST ?? "").trim().toLowerCase();
  if (!SHA256.test(digest)) {
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", "cloud workspace template digest is missing or malformed", "blocked");
  }
  if (provider === "vercel" && identity !== "node22") {
    throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", "Vercel Sandbox must attest the stock node22 runtime", "blocked");
  }
  return {
    provider,
    deploymentId,
    sdk: CLOUD_PROVIDER_SDKS[provider],
    template: { identity, digest },
    runtime: {
      identity: CLOUD_WORKSPACE_RUNTIME_IDENTITY,
      digest: cloudProviderRuntimeDigest(CLOUD_WORKSPACE_RUNTIME_IDENTITY, digest),
    },
  };
}

/** Resolve only the SDK-attested version of the Trigger deployment executing this task. */
export function actualTriggerDeploymentId(
  runtimeAttestation: CloudProviderRuntimeAttestation,
  provider: CloudWorkspaceProviderName,
): string {
  const actual = String(runtimeAttestation.triggerDeploymentVersion ?? "").trim();
  if (!SAFE_ID.test(actual) || UNVERSIONED_DEPLOYMENT.test(actual)) {
    throw new CloudWorkspaceError(
      provider,
      "provider_probe_attestation_failed",
      "actual Trigger worker deployment identity is missing, unversioned, or malformed",
      "blocked",
    );
  }
  return actual;
}

/** Normal worker verification must bind to provider-observed runtime state. */
export function runtimeCloudProviderProbeBinding(
  env: Readonly<Record<string, string | undefined>>,
  runtimeAttestation: CloudProviderRuntimeAttestation,
): CloudProviderProbeBinding {
  const configured = configuredCloudProviderProbeBinding(env);
  const actualDeploymentId = actualTriggerDeploymentId(runtimeAttestation, configured.provider);
  if (configured.deploymentId !== actualDeploymentId) {
    throw new CloudWorkspaceError(
      configured.provider,
      "provider_probe_attestation_failed",
      "configured cloud provider deployment identity conflicts with the actual Trigger worker deployment",
      "blocked",
    );
  }
  return { ...configured, deploymentId: actualDeploymentId };
}

function isStrictReceipt(value: unknown): value is CloudProviderProbeReceipt {
  if (!record(value) || !exactKeys(value, RECEIPT_KEYS)) return false;
  const sdk = value.sdk;
  const template = value.template;
  const runtime = value.runtime;
  const observed = value.observed;
  if (!record(sdk) || !exactKeys(sdk, ["package", "version"])) return false;
  if (!record(template) || !exactKeys(template, ["identity", "digest"])) return false;
  if (!record(runtime) || !exactKeys(runtime, ["identity", "digest"])) return false;
  if (!record(observed) || !exactKeys(observed, ["cpu", "memoryMb", "ttlMs", "quota", "privateIngress", "emptyEnvironment", "networkDeny", "exactCancellation", "lifecycle"])) return false;
  const quota = observed.quota;
  const lifecycle = observed.lifecycle;
  if (!record(quota) || !exactKeys(quota, ["cpu", "memory", "activeSandboxes"])) return false;
  if (!record(lifecycle) || !exactKeys(lifecycle, ["create", "exec", "checkpoint", "terminate", "recreate", "identityChanged"])) return false;
  return value.schemaVersion === CLOUD_PROVIDER_PROBE_SCHEMA_VERSION
    && typeof value.provider === "string" && value.provider in CLOUD_PROVIDER_SDKS
    && typeof value.deploymentId === "string" && SAFE_ID.test(value.deploymentId)
    && typeof sdk.package === "string" && typeof sdk.version === "string"
    && typeof template.identity === "string" && SHA256.test(String(template.digest))
    && typeof runtime.identity === "string" && SHA256.test(String(runtime.digest))
    && Array.isArray(value.exercisedCapabilities)
    && value.exercisedCapabilities.every((item) => typeof item === "string")
    && Number.isFinite(observed.cpu) && Number(observed.cpu) > 0
    && Number.isFinite(observed.memoryMb) && Number(observed.memoryMb) > 0
    && Number.isFinite(observed.ttlMs) && Number(observed.ttlMs) > 0
    && quota.cpu === true && quota.memory === true && quota.activeSandboxes === true
    && observed.privateIngress === true && observed.emptyEnvironment === true
    && observed.networkDeny === true && observed.exactCancellation === true
    && lifecycle.create === true && lifecycle.exec === true && lifecycle.checkpoint === true
    && lifecycle.terminate === true && lifecycle.recreate === true && lifecycle.identityChanged === true
    && Number.isSafeInteger(value.probeTime) && Number.isSafeInteger(value.expiresAt)
    && typeof value.runId === "string" && SAFE_ID.test(value.runId)
    && typeof value.nonce === "string" && /^[a-zA-Z0-9_-]{16,200}$/.test(value.nonce);
}

function matchesBinding(receipt: CloudProviderProbeReceipt, expected: CloudProviderProbeBinding): boolean {
  return receipt.provider === expected.provider
    && receipt.deploymentId === expected.deploymentId
    && receipt.sdk.package === expected.sdk.package
    && receipt.sdk.version === expected.sdk.version
    && receipt.template.identity === expected.template.identity
    && receipt.template.digest === expected.template.digest
    && receipt.runtime.identity === expected.runtime.identity
    && receipt.runtime.digest === expected.runtime.digest;
}

function fullyExercised(receipt: CloudProviderProbeReceipt): boolean {
  return JSON.stringify(receipt.exercisedCapabilities) === JSON.stringify(REQUIRED_CLOUD_WORKSPACE_CAPABILITIES)
    && receipt.observed.cpu <= DEFAULT_WORKSPACE_LIMITS.cpu
    && receipt.observed.memoryMb <= DEFAULT_WORKSPACE_LIMITS.memoryMb
    && receipt.observed.ttlMs <= DEFAULT_WORKSPACE_LIMITS.ttlMs;
}

export function createCloudProviderProbeKeyring(current: CloudProviderProbeKey, previous: readonly CloudProviderProbeKey[] = []) {
  const entries = [current, ...previous];
  if (!KEY_ID.test(current.keyId) || new Set(entries.map((entry) => entry.keyId)).size !== entries.length) {
    throw new Error("cloud provider probe key ids are invalid or conflicting");
  }
  const keys = new Map(entries.map((entry) => {
    if (!KEY_ID.test(entry.keyId)) throw new Error("cloud provider probe key id is invalid");
    const key = Buffer.from(entry.secret);
    if (key.byteLength < 32) throw new Error("cloud provider probe authority requires at least 32 bytes");
    return [entry.keyId, key] as const;
  }));
  const sign = (receipt: CloudProviderProbeReceipt, key: Buffer) =>
    createHmac("sha256", key).update(canonicalProviderProbeJson(receipt)).digest("hex");
  return {
    issue(receipt: CloudProviderProbeReceipt): CloudProviderProbeEnvelope {
      if (!isStrictReceipt(receipt) || !fullyExercised(receipt)) throw new Error("cloud provider probe receipt is malformed or partial");
      const immutable = JSON.parse(canonicalProviderProbeJson(receipt)) as CloudProviderProbeReceipt;
      return Object.freeze({ keyId: current.keyId, receipt: immutable, signature: sign(immutable, keys.get(current.keyId)!) });
    },
    verify(envelope: CloudProviderProbeEnvelope, expected: CloudProviderProbeBinding, now = Date.now()): boolean {
      if (!record(envelope) || !exactKeys(envelope, ["keyId", "receipt", "signature"])) return false;
      if (!KEY_ID.test(String(envelope.keyId)) || !/^[0-9a-f]{64}$/.test(String(envelope.signature))) return false;
      if (!isStrictReceipt(envelope.receipt) || !matchesBinding(envelope.receipt, expected) || !fullyExercised(envelope.receipt)) return false;
      if (envelope.receipt.probeTime > now + 60_000 || envelope.receipt.expiresAt <= now) return false;
      if (envelope.receipt.expiresAt <= envelope.receipt.probeTime
        || envelope.receipt.expiresAt - envelope.receipt.probeTime > cloudProviderProbeMaxAgeMs(envelope.receipt.provider)) return false;
      const key = keys.get(envelope.keyId);
      if (!key) return false;
      const actual = Buffer.from(envelope.signature, "hex");
      const wanted = Buffer.from(sign(envelope.receipt, key), "hex");
      return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    },
  };
}

export function configuredCloudProviderProbeKeyring(env: Readonly<Record<string, string | undefined>>) {
  const serialized = env.JARVIS_CLOUD_PROVIDER_PROBE_KEYRING;
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as { current?: CloudProviderProbeKey; previous?: CloudProviderProbeKey[] };
    if (!record(value.current) || typeof value.current.keyId !== "string" || typeof value.current.secret !== "string") return null;
    if (!Array.isArray(value.previous) || value.previous.some((entry) => !record(entry) || typeof entry.keyId !== "string" || typeof entry.secret !== "string")) return null;
    return createCloudProviderProbeKeyring(value.current, value.previous);
  } catch {
    return null;
  }
}

function blocked(provider: CloudWorkspaceProviderName, detail: string): never {
  throw new CloudWorkspaceError(provider, "provider_probe_attestation_failed", detail, "blocked");
}

export function installedCloudProviderSdkVersion(provider: CloudWorkspaceProviderName): string | null {
  try {
    const packageName = provider === "e2b" ? "e2b" : provider === "sandbox0" ? "sandbox0" : provider === "vercel" ? "@vercel/sandbox" : null;
    if (!packageName) return null;
    // Trigger builds and the local live probe can execute this module through
    // different ESM/CommonJS transforms. Read the pinned top-level dependency
    // first because ESM-only packages may intentionally expose no CJS entry.
    const directPackageJson = join(process.cwd(), "node_modules", packageName, "package.json");
    if (existsSync(directPackageJson)) {
      const parsed = JSON.parse(readFileSync(directPackageJson, "utf8")) as { name?: unknown; version?: unknown };
      if (parsed.name === packageName) return String(parsed.version ?? "");
    }
    // The resolver fallback covers hoisted/nonstandard layouts while still
    // proving the package that this deployment will load.
    let directory = dirname(createRequire(join(process.cwd(), "package.json")).resolve(packageName));
    for (let depth = 0; depth < 5; depth += 1) {
      const packageJson = join(directory, "package.json");
      if (existsSync(packageJson)) {
        const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === packageName) return String(parsed.version ?? "");
      }
      directory = dirname(directory);
    }
    return null;
  } catch {
    return null;
  }
}

export function assertCloudProviderExecutionReady(
  env: Readonly<Record<string, string | undefined>>,
  runtimeAttestation: CloudProviderRuntimeAttestation,
  now = Date.now(),
): CloudProviderProbeReceipt {
  const binding = runtimeCloudProviderProbeBinding(env, runtimeAttestation);
  if (installedCloudProviderSdkVersion(binding.provider) !== binding.sdk.version) {
    blocked(binding.provider, "installed cloud provider SDK does not match the pinned receipt tuple");
  }
  const authority = configuredCloudProviderProbeKeyring(env);
  if (!authority) blocked(binding.provider, "rotating cloud provider probe verifier is unavailable");
  let envelope: CloudProviderProbeEnvelope;
  try {
    envelope = JSON.parse(String(env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT ?? "")) as CloudProviderProbeEnvelope;
  } catch {
    return blocked(binding.provider, "cloud provider probe receipt is missing or malformed");
  }
  if (!authority.verify(envelope, binding, now)) {
    blocked(binding.provider, "cloud provider probe receipt is stale, partial, tampered, conflicting, or bound to a different deployment tuple");
  }
  return envelope.receipt;
}
