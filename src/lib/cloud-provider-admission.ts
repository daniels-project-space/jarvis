import { configuredCloudWorkspaceProviderName } from "./cloud-provider-selection";

const PROVIDERS = new Set(["e2b", "sandbox0", "vercel", "cloudflare"]);
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9._:/-]{1,200}$/;
const KEY_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_RECEIPT_LIFETIME_MS = 24 * 60 * 60_000;

type AdmissionFailureCode =
  | "missing_configuration"
  | "malformed_configuration"
  | "missing_receipt"
  | "malformed_receipt"
  | "stale_receipt"
  | "mismatched_receipt";

export type CloudProviderAdmissionReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; code: AdmissionFailureCode }>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Cheap controller-side admission guard for Goal Mode.
 *
 * This intentionally validates only non-secret deployment identity and receipt
 * freshness. The Trigger worker remains authoritative for the receipt HMAC,
 * provider capabilities, SDK/runtime identity, and live execution boundary.
 */
export function cloudProviderAdmissionReadiness(
  env: Readonly<Record<string, string | undefined>>,
  now = Date.now(),
): CloudProviderAdmissionReadiness {
  const provider = configuredCloudWorkspaceProviderName(env) ?? "";
  const templateIdentity = String(env.JARVIS_CLOUD_WORKSPACE_TEMPLATE ?? "").trim();
  const templateDigest = String(env.JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST ?? "").trim().toLowerCase();
  const deploymentId = String(env.JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID ?? "").trim();
  const serializedReceipt = String(env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT ?? "").trim();

  if (!provider || !templateIdentity || !templateDigest || !deploymentId) {
    return { ready: false, code: "missing_configuration" };
  }
  if (!PROVIDERS.has(provider)
    || templateIdentity.length > 240
    || !SHA256.test(templateDigest)
    || !SAFE_ID.test(deploymentId)) {
    return { ready: false, code: "malformed_configuration" };
  }
  if (!serializedReceipt) return { ready: false, code: "missing_receipt" };

  let envelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(serializedReceipt) as unknown;
    if (!record(parsed)) return { ready: false, code: "malformed_receipt" };
    envelope = parsed;
  } catch {
    return { ready: false, code: "malformed_receipt" };
  }

  if (!KEY_ID.test(String(envelope.keyId ?? ""))
    || !SIGNATURE.test(String(envelope.signature ?? ""))
    || !record(envelope.receipt)) {
    return { ready: false, code: "malformed_receipt" };
  }
  const receipt = envelope.receipt;
  if (receipt.schemaVersion !== 1
    || typeof receipt.provider !== "string"
    || typeof receipt.deploymentId !== "string"
    || !record(receipt.template)
    || typeof receipt.template.identity !== "string"
    || typeof receipt.template.digest !== "string"
    || typeof receipt.probeTime !== "number"
    || typeof receipt.expiresAt !== "number"
    || !Number.isSafeInteger(receipt.probeTime)
    || !Number.isSafeInteger(receipt.expiresAt)) {
    return { ready: false, code: "malformed_receipt" };
  }

  const probeTime = Number(receipt.probeTime);
  const expiresAt = Number(receipt.expiresAt);
  if (!Number.isSafeInteger(now)
    || probeTime <= 0
    || probeTime > now + MAX_FUTURE_SKEW_MS
    || expiresAt <= now
    || expiresAt <= probeTime
    || expiresAt - probeTime > MAX_RECEIPT_LIFETIME_MS) {
    return { ready: false, code: "stale_receipt" };
  }

  if (receipt.provider !== provider
    || receipt.deploymentId !== deploymentId
    || receipt.template.identity !== templateIdentity
    || receipt.template.digest !== templateDigest) {
    return { ready: false, code: "mismatched_receipt" };
  }
  return { ready: true };
}
