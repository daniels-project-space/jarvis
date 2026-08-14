import { createHash } from "node:crypto";

import {
  configuredNovitaPatchProposer,
  type NovitaPatchProposerRuntimeConfig,
} from "./novita-patch-proposer-attestation";

export type NovitaPatchProposerConfigurationReadiness = Readonly<{
  configured: boolean;
  code:
    | "attestation_not_configured"
    | "attestation_invalid"
    | "runtime_config_digest_mismatch"
    | "attestation_ready";
}>;

/**
 * The digest binds the endpoint and immutable delegate description without
 * returning either to an owner-facing caller. It is checked again by the
 * Trigger worker before it can make a provider request.
 */
export function novitaPatchProposerRuntimeConfigDigest(
  config: NovitaPatchProposerRuntimeConfig,
): string {
  const value = {
    endpointUrl: config.endpointUrl,
    adapterId: config.attestation.adapterId,
    endpointId: config.attestation.endpointId,
    modelId: config.attestation.modelId,
    modelRevision: config.attestation.modelRevision,
    imageDigest: config.attestation.imageDigest,
    quantization: config.attestation.quantization,
    api: config.attestation.api,
    endpointAuth: config.attestation.endpointAuth,
    requestLimits: config.attestation.requestLimits,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * This is deliberately a local configuration check. It never reads the
 * scoped Novita credential, calls the vault, or contacts Novita, so opening
 * Settings cannot turn a disabled delegate into provider egress.
 */
export function novitaPatchProposerConfigurationReadiness(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NovitaPatchProposerConfigurationReadiness {
  if (!environment.JARVIS_NOVITA_QWEN_ATTESTATION?.trim()) {
    return Object.freeze({ configured: false, code: "attestation_not_configured" as const });
  }
  const config = configuredNovitaPatchProposer(environment);
  if (!config) return Object.freeze({ configured: false, code: "attestation_invalid" as const });
  if (novitaPatchProposerRuntimeConfigDigest(config) !== config.attestation.configDigest) {
    return Object.freeze({ configured: false, code: "runtime_config_digest_mismatch" as const });
  }
  return Object.freeze({ configured: true, code: "attestation_ready" as const });
}
