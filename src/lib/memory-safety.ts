const LABELED_VALUE = /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd|passphrase|private[_ -]?key|recovery[_ -]?(?:code|phrase)|seed[_ -]?phrase|vault[_ -]?(?:key|token)|secret)\b\s*(?:is|was|equals?|[:=])\s*(?!(?:configured|stored|managed|available|encrypted|redacted|rotated|set)\b)[^\s,.;]{6,}/i;
const ASSIGNMENT = /\b[A-Z][A-Z0-9_]{2,}\s*[:=]\s*["']?[^\s"']{8,}/;
const BEARER = /\bbearer\s+[a-z0-9._~+\/-]{16,}/i;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const KNOWN_TOKEN = /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/;
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9_+\/.=-]{32,}\b)(?=[A-Za-z0-9_+\/.=-]*[A-Za-z])(?=[A-Za-z0-9_+\/.=-]*\d)[A-Za-z0-9_+\/.=-]+\b/g;

export const MEMORY_SECRET_POLICY =
  "Never save credentials, passwords, API keys, tokens, private keys, recovery codes, seed phrases, or raw environment-variable values. Save only a non-secret note that access is configured when that fact is durable.";

export function containsLikelySecret(value: unknown): boolean {
  const text = String(value ?? "");
  if (PEM.test(text) || BEARER.test(text) || KNOWN_TOKEN.test(text) || ASSIGNMENT.test(text) || LABELED_VALUE.test(text)) return true;
  return [...text.matchAll(HIGH_ENTROPY)].some(([candidate]) => {
    const unique = new Set(candidate).size;
    return unique >= 10 && !/^https?:\/\//i.test(candidate);
  });
}

export function redactSecrets(value: unknown): string {
  let text = String(value ?? "");
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
  text = text.replace(BEARER, "Bearer [REDACTED]");
  text = text.replace(KNOWN_TOKEN, "[REDACTED TOKEN]");
  text = text.replace(ASSIGNMENT, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
  text = text.replace(HIGH_ENTROPY, (candidate) => {
    const unique = new Set(candidate).size;
    return unique >= 10 && !/^https?:\/\//i.test(candidate) ? "[REDACTED SECRET]" : candidate;
  });
  return text;
}

export function safeMemoryNote(title: unknown, body: unknown): { title: string; body: string } | null {
  const normalized = {
    title: String(title ?? "").trim().slice(0, 120),
    body: String(body ?? "").trim().slice(0, 1200),
  };
  if (!normalized.title || !normalized.body || containsLikelySecret(normalized.title) || containsLikelySecret(normalized.body)) {
    return null;
  }
  return normalized;
}
