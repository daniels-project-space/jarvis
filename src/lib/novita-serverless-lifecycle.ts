import type { NovitaPatchProposerRuntimeConfig } from "./novita-patch-proposer-attestation";

type FetchLike = typeof fetch;
type RecordValue = Record<string, unknown>;

const NOVITA_ENDPOINTS_URL = "https://api.novita.ai/gpu-instance/openapi/v1/endpoints";
const RESPONSE_MAX_BYTES = 1_000_000;
const CONTROL_PLANE_TIMEOUT_MS = 12_000;
const NOVITA_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
// A digest pin is only meaningful when it is the terminal identity of an
// untagged OCI-style image reference. In particular, do not accept an
// attested digest merely occurring inside a mutable tag or another suffix.
const CONTENT_ADDRESSED_IMAGE_REFERENCE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@(?<digest>sha256:[a-f0-9]{64})$/;

export type NovitaServerlessLifecycleCheck = Readonly<{
  status: "ready" | "idle";
}> | Readonly<{
  status: "unavailable";
  reason:
    | "provider_request_failed"
    | "provider_timeout"
    | "provider_response_invalid"
    | "provider_response_too_large"
    | "provider_http_error"
    | "endpoint_missing"
    | "endpoint_ambiguous"
    | "endpoint_url_mismatch"
    | "image_digest_mismatch"
    | "lifecycle_config_mismatch"
    | "endpoint_unhealthy";
}>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function sameEndpointUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    if (a.protocol !== "https:" || b.protocol !== "https:" || a.username || a.password || b.username || b.password) return false;
    if (a.search || a.hash || b.search || b.hash) return false;
    return a.toString().replace(/\/$/, "") === b.toString().replace(/\/$/, "");
  } catch {
    return false;
  }
}

function endpointPort(value: unknown): number | null {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return null;
  return positiveInteger(value[0].port);
}

function isExactAttestedImageReference(value: unknown, expectedDigest: string): boolean {
  if (typeof value !== "string") return false;
  return CONTENT_ADDRESSED_IMAGE_REFERENCE.exec(value)?.groups?.digest === expectedDigest;
}

async function boundedJson(response: Response): Promise<unknown | "too_large" | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) return "too_large";
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read-only proof that the exact sealed custom endpoint still has the
 * scale-to-zero policy expected by Jarvis. It never probes the endpoint URL:
 * an HTTP health probe could itself cold-start a billed worker.
 */
export async function verifyNovitaServerlessLifecycle(input: Readonly<{
  config: NovitaPatchProposerRuntimeConfig;
  apiKey: string;
  fetchImpl?: FetchLike;
}>): Promise<NovitaServerlessLifecycleCheck> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTROL_PLANE_TIMEOUT_MS);
  timeout.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(NOVITA_ENDPOINTS_URL, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        "user-agent": NOVITA_USER_AGENT,
      },
    });
  } catch (error) {
    clearTimeout(timeout);
    return Object.freeze({
      status: "unavailable" as const,
      reason: error instanceof DOMException && error.name === "AbortError" ? "provider_timeout" : "provider_request_failed",
    });
  }
  clearTimeout(timeout);
  if (!response.ok) return Object.freeze({ status: "unavailable" as const, reason: "provider_http_error" });
  const payload = await boundedJson(response);
  if (payload === "too_large") return Object.freeze({ status: "unavailable" as const, reason: "provider_response_too_large" });
  if (!isRecord(payload) || !Array.isArray(payload.endpoints)) {
    return Object.freeze({ status: "unavailable" as const, reason: "provider_response_invalid" });
  }

  const endpoints = payload.endpoints.filter(isRecord).filter((endpoint) => endpoint.id === input.config.attestation.endpointId);
  if (!endpoints.length) return Object.freeze({ status: "unavailable" as const, reason: "endpoint_missing" });
  if (endpoints.length !== 1) return Object.freeze({ status: "unavailable" as const, reason: "endpoint_ambiguous" });
  const endpoint = endpoints[0];
  if (typeof endpoint.url !== "string" || !sameEndpointUrl(endpoint.url, input.config.endpointUrl)) {
    return Object.freeze({ status: "unavailable" as const, reason: "endpoint_url_mismatch" });
  }
  const image = isRecord(endpoint.image) ? endpoint.image : null;
  if (!image || !isExactAttestedImageReference(image.image, input.config.attestation.imageDigest)) {
    return Object.freeze({ status: "unavailable" as const, reason: "image_digest_mismatch" });
  }
  const workerConfig = isRecord(endpoint.workerConfig) ? endpoint.workerConfig : null;
  const health = isRecord(endpoint.healthy) ? endpoint.healthy : null;
  const lifecycle = input.config.lifecycle;
  if (!workerConfig
    || positiveInteger(workerConfig.minNum) !== lifecycle.minWorkers
    || positiveInteger(workerConfig.maxNum) !== lifecycle.maxWorkers
    || positiveInteger(workerConfig.freeTimeout) !== lifecycle.idleTimeoutSeconds
    || positiveInteger(workerConfig.maxConcurrent) !== lifecycle.maxConcurrent
    || positiveInteger(workerConfig.gpuNum) !== lifecycle.gpuNum
    || endpointPort(endpoint.ports) !== lifecycle.port
    || image.command !== lifecycle.startupCommand
    || !health || health.path !== lifecycle.healthPath) {
    return Object.freeze({ status: "unavailable" as const, reason: "lifecycle_config_mismatch" });
  }
  const state = isRecord(endpoint.state) ? endpoint.state : null;
  if (state && (typeof state.error === "string" && state.error.trim() || typeof state.message === "string" && state.message.trim())) {
    return Object.freeze({ status: "unavailable" as const, reason: "endpoint_unhealthy" });
  }
  if (!Array.isArray(endpoint.workers)) return Object.freeze({ status: "unavailable" as const, reason: "provider_response_invalid" });
  if (!endpoint.workers.length) return Object.freeze({ status: "idle" as const });
  if (endpoint.workers.length > lifecycle.maxWorkers
    || endpoint.workers.some((worker) => !isRecord(worker) || worker.healthy !== true
      || isRecord(worker.state) && ((typeof worker.state.error === "string" && worker.state.error.trim()) || (typeof worker.state.message === "string" && worker.state.message.trim())))) {
    return Object.freeze({ status: "unavailable" as const, reason: "endpoint_unhealthy" });
  }
  return Object.freeze({ status: "ready" as const });
}
