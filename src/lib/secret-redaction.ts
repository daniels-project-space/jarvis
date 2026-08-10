const SENSITIVE_ENV_NAME = /(?:api_?key|(?:access|secret)_?key(?:_?id)?|(?:access|refresh|id|session)_?token|auth(?:orization)?|secret|password|private_?key|project_?id)/i;

const TOKEN_PATTERN = /\b(?:bb_live_|github_pat_|gh[pousr]_|sk-(?:proj-)?|nvapi-|vcp_)[a-zA-Z0-9_.-]{8,}\b|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{4,}\b/g;
const AUTHORIZATION_VALUE_PATTERN = /\b((?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{6,}/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;
const CREDENTIAL_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const ASSIGNMENT_PATTERN = /((?:api[_-]?key|(?:access|secret)[_-]?key(?:[_-]?id)?|(?:access|refresh|id|session)[_-]?token|auth(?:orization)?|secret|password|private[_-]?key|project[_-]?id)[\\"']*\s*[:=]\s*[\\"']*)(?!Bearer\b|Basic\b|Token\b)([^\\"'\s,}]{6,})/gi;

export function redactSensitiveText(
  input: string,
  environment: Readonly<Record<string, string | undefined>> = {},
): string {
  let output = String(input ?? "");
  for (const [name, value] of Object.entries(environment)) {
    if (!SENSITIVE_ENV_NAME.test(name) || !value || value.length < 6) continue;
    output = output.split(value).join(`[REDACTED:${name}]`);
  }
  return output
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(CREDENTIAL_URL_PATTERN, "$1[REDACTED]@")
    .replace(AUTHORIZATION_VALUE_PATTERN, "$1[REDACTED]")
    .replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(ASSIGNMENT_PATTERN, "$1[REDACTED]");
}
