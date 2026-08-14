import type { WorkModelTier } from "./work-models";
import { isOwnedRepositoryScope } from "./workflow-contract";

/**
 * Non-secret identity for the one deliberately narrow open-weight delegate.
 * The URL is deployment configuration, never part of a work-order record.
 */
export const NOVITA_PATCH_PROPOSER_ADAPTER_ID = "novita-qwen-patch-proposer-v1" as const;

export type NovitaPatchProposerLimits = Readonly<{
  maxInputBytes: number;
  maxOutputTokens: number;
  maxTurns: 1;
  timeoutMs: number;
}>;

export type NovitaPatchProposerAttestation = Readonly<{
  adapterId: typeof NOVITA_PATCH_PROPOSER_ADAPTER_ID;
  configDigest: string;
  endpointId: string;
  modelId: string;
  modelRevision: string;
  imageDigest: string;
  quantization: "gptq-int4";
  api: "openai-chat-completions";
  endpointAuth: "hmac-sha256-v1";
  requestLimits: NovitaPatchProposerLimits;
}>;

export type NovitaPatchProposerRuntimeConfig = Readonly<{
  endpointUrl: string;
  attestation: NovitaPatchProposerAttestation;
}>;

type RecordValue = Record<string, unknown>;

const ATTESTATION_KEYS = new Set([
  "adapterId",
  "configDigest",
  "endpointId",
  "modelId",
  "modelRevision",
  "imageDigest",
  "quantization",
  "api",
  "endpointAuth",
  "requestLimits",
]);

const RUNTIME_CONFIG_KEYS = new Set(["endpointUrl", ...ATTESTATION_KEYS]);
const LIMIT_KEYS = new Set(["maxInputBytes", "maxOutputTokens", "maxTurns", "timeoutMs"]);
const SHA256 = /^[a-f0-9]{64}$/;
const MODEL_REVISION = /^[a-f0-9]{40,64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ENDPOINT_ID = /^[a-zA-Z0-9_-]{6,160}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,240}$/;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: RecordValue, expected: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => expected.has(key))
    && [...expected].every((key) => Object.hasOwn(value, key));
}

function positiveInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function resolvedLimits(value: unknown): NovitaPatchProposerLimits | null {
  if (!isRecord(value) || !exactKeys(value, LIMIT_KEYS)) return null;
  const maxInputBytes = positiveInteger(value.maxInputBytes, 2_048, 60_000);
  const maxOutputTokens = positiveInteger(value.maxOutputTokens, 64, 2_048);
  const maxTurns = value.maxTurns === 1 ? 1 : null;
  const timeoutMs = positiveInteger(value.timeoutMs, 5_000, 600_000);
  return maxInputBytes && maxOutputTokens && maxTurns && timeoutMs
    ? Object.freeze({ maxInputBytes, maxOutputTokens, maxTurns, timeoutMs })
    : null;
}

/** Parse the non-secret immutable subset that is allowed into a work order. */
export function resolveNovitaPatchProposerAttestation(value: unknown): NovitaPatchProposerAttestation | null {
  if (!isRecord(value) || !exactKeys(value, ATTESTATION_KEYS)) return null;
  const limits = resolvedLimits(value.requestLimits);
  if (!limits
    || value.adapterId !== NOVITA_PATCH_PROPOSER_ADAPTER_ID
    || typeof value.configDigest !== "string" || !SHA256.test(value.configDigest)
    || typeof value.endpointId !== "string" || !ENDPOINT_ID.test(value.endpointId)
    || typeof value.modelId !== "string" || !MODEL_ID.test(value.modelId)
    || typeof value.modelRevision !== "string" || !MODEL_REVISION.test(value.modelRevision)
    || typeof value.imageDigest !== "string" || !IMAGE_DIGEST.test(value.imageDigest)
    || value.quantization !== "gptq-int4"
    || value.api !== "openai-chat-completions"
    || value.endpointAuth !== "hmac-sha256-v1") return null;
  return Object.freeze({
    adapterId: NOVITA_PATCH_PROPOSER_ADAPTER_ID,
    configDigest: value.configDigest,
    endpointId: value.endpointId,
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    imageDigest: value.imageDigest,
    quantization: "gptq-int4",
    api: "openai-chat-completions",
    endpointAuth: "hmac-sha256-v1",
    requestLimits: limits,
  });
}

/**
 * This parser is safe in Convex as well as Node: it does not read the vault,
 * call the network, or retain the endpoint URL in the returned attestation.
 */
export function configuredNovitaPatchProposer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NovitaPatchProposerRuntimeConfig | null {
  const encoded = environment.JARVIS_NOVITA_QWEN_ATTESTATION;
  if (!encoded || encoded.length > 8_000) return null;
  try {
    const raw: unknown = JSON.parse(encoded);
    if (!isRecord(raw) || !exactKeys(raw, RUNTIME_CONFIG_KEYS)) return null;
    if (typeof raw.endpointUrl !== "string") return null;
    const url = new URL(raw.endpointUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith("/")
      || (url.hostname !== "api.novita.ai" && !url.hostname.endsWith(".novita.ai"))) return null;
    const attestationValue = Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "endpointUrl"),
    );
    const attestation = resolveNovitaPatchProposerAttestation(attestationValue);
    return attestation ? Object.freeze({ endpointUrl: url.toString().replace(/\/$/, ""), attestation }) : null;
  } catch {
    return null;
  }
}

function taskNamesBoundedSourceFile(task: string): boolean {
  return /(?:^|[\s`'"(])(?:src|app|convex|scripts)\/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]sx?)(?=$|[\s`'"),.:;])/i.test(task);
}

/**
 * The only class of source change that may receive an untrusted Qwen draft.
 * This is deliberately narrower than general engineering work: no deployment,
 * migration, security, architecture, or multi-file task can qualify.
 */
export function isBoundedNovitaPatchTask(task: string): boolean {
  const normalized = task.trim();
  if (!normalized || normalized.length > 480 || !taskNamesBoundedSourceFile(normalized)) return false;
  if (/\b(?:deploy|publish|merge|production|migration|security|architecture|redesign|multi[- ]?file|database|credential|secret)\b/i.test(normalized)) {
    return false;
  }
  return /\b(?:fix|correct|rename|update|add)\b/i.test(normalized)
    && /\b(?:typo|spelling|comment|copy|label|text|constant|test(?: expectation)?|one[- ]line|small)\b/i.test(normalized);
}

/**
 * Selection stays intentionally conservative. The delegate is an untrusted,
 * no-tool draft writer. A trusted Terra Codex turn still performs every edit,
 * verification, review, and delivery step, so only tiny explicitly named
 * owned-repository fixes may request it. Everything else remains Codex-only.
 */
export function novitaPatchProposerForWorkOrder(input: Readonly<{
  task: string;
  modelTier: WorkModelTier;
  readonly: boolean;
  repository?: string;
  sourceProvider: "github" | "none";
  risk: string;
  approvalRequired: boolean;
  mcpScope: readonly string[];
}>): NovitaPatchProposerAttestation | undefined {
  const configured = configuredNovitaPatchProposer();
  if (!configured
    || input.modelTier !== "terra"
    || input.readonly
    || input.sourceProvider !== "github"
    || !input.repository || !isOwnedRepositoryScope(input.repository)
    || input.risk !== "low"
    || input.approvalRequired
    || input.mcpScope.length > 0
    || !isBoundedNovitaPatchTask(input.task)) return undefined;
  return configured.attestation;
}

export function canonicalNovitaPatchProposerAttestation(value: NovitaPatchProposerAttestation): string {
  return JSON.stringify({
    adapterId: value.adapterId,
    configDigest: value.configDigest,
    endpointId: value.endpointId,
    modelId: value.modelId,
    modelRevision: value.modelRevision,
    imageDigest: value.imageDigest,
    quantization: value.quantization,
    api: value.api,
    endpointAuth: value.endpointAuth,
    requestLimits: value.requestLimits,
  });
}
