import type { NovitaPatchProposerAttestation } from "./novita-patch-proposer-attestation";

/**
 * Canonical preimages for hash-only durable records at the optional Qwen draft
 * boundary. Callers must hash these transient strings; they must never persist
 * task text, source paths/content, diffs, endpoint URLs, or auth.
 */
export const NOVITA_PATCH_PROPOSAL_RECEIPT_PROTOCOL_VERSION = 1 as const;

export const NOVITA_PATCH_PROPOSAL_OUTCOMES = Object.freeze([
  "proposed",
  "no_change",
  "skipped",
  "unavailable",
  "rejected",
] as const);

export type NovitaPatchProposalOutcome = (typeof NOVITA_PATCH_PROPOSAL_OUTCOMES)[number];

export const NOVITA_PATCH_PROPOSAL_FAILURE_CLASSES = Object.freeze([
  "configuration",
  "input",
  "transport",
  "timeout",
  "http",
  "response",
] as const);

export type NovitaPatchProposalFailureClass = (typeof NOVITA_PATCH_PROPOSAL_FAILURE_CLASSES)[number];

export type NovitaProposalSourceDigest = Readonly<{
  path: string;
  contentDigest: string;
}>;

export function canonicalNovitaPatchProposalRequest(input: Readonly<{
  attestation: NovitaPatchProposerAttestation;
  /** SHA-256 of the policy task sealed in the immutable work-order revision. */
  policyTaskDigest: string;
  sourceFiles: readonly NovitaProposalSourceDigest[];
}>): string {
  return JSON.stringify({
    protocolVersion: NOVITA_PATCH_PROPOSAL_RECEIPT_PROTOCOL_VERSION,
    adapterId: input.attestation.adapterId,
    configDigest: input.attestation.configDigest,
    endpointId: input.attestation.endpointId,
    modelId: input.attestation.modelId,
    modelRevision: input.attestation.modelRevision,
    imageDigest: input.attestation.imageDigest,
    api: input.attestation.api,
    policyTaskDigest: input.policyTaskDigest,
    sourceFiles: input.sourceFiles.map((file) => ({ path: file.path, contentDigest: file.contentDigest })),
  });
}

export function canonicalNovitaPatchProposalReservation(input: Readonly<{
  workOrderRevisionDigest: string;
  attestation: NovitaPatchProposerAttestation;
  /** Server-validated SHA-256 of the immutable policy task. */
  policyTaskDigest: string;
  requestDigest: string;
  sourceFileCount: number;
  inputBytes: number;
}>): string {
  return JSON.stringify({
    protocolVersion: NOVITA_PATCH_PROPOSAL_RECEIPT_PROTOCOL_VERSION,
    workOrderRevisionDigest: input.workOrderRevisionDigest,
    adapterId: input.attestation.adapterId,
    configDigest: input.attestation.configDigest,
    endpointId: input.attestation.endpointId,
    policyTaskDigest: input.policyTaskDigest,
    requestDigest: input.requestDigest,
    sourceFileCount: input.sourceFileCount,
    inputBytes: input.inputBytes,
  });
}

export function canonicalNovitaPatchProposalOutcome(input: Readonly<{
  reservationDigest: string;
  outcome: NovitaPatchProposalOutcome;
  failureClass?: NovitaPatchProposalFailureClass;
  outputBytes: number;
}>): string {
  return JSON.stringify({
    protocolVersion: NOVITA_PATCH_PROPOSAL_RECEIPT_PROTOCOL_VERSION,
    reservationDigest: input.reservationDigest,
    outcome: input.outcome,
    failureClass: input.failureClass ?? null,
    outputBytes: input.outputBytes,
  });
}

export function novitaPatchProposalFailureClass(
  outcome: NovitaPatchProposalOutcome,
  reason?: string,
): NovitaPatchProposalFailureClass | undefined {
  if (outcome === "proposed" || outcome === "no_change") return undefined;
  if (reason === "timeout") return "timeout";
  if (/^http_\d{3}$/.test(String(reason ?? ""))) return "http";
  if (outcome === "skipped") return "input";
  if (/^(?:attestation_mismatch|runtime_config_digest_mismatch|invalid_endpoint_url|api_key_unavailable|missing_api_key)$/.test(String(reason ?? ""))) {
    return "configuration";
  }
  if (/^(?:non_json_response|response_out_of_bounds|completion_out_of_bounds|malformed_proposal|proposal_out_of_bounds)$/.test(String(reason ?? ""))) {
    return "response";
  }
  return "transport";
}
