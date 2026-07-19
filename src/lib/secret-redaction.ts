const SENSITIVE_ENV_NAME = /(?:api_?key|access_?token|auth(?:orization)?|secret|password|private_?key|project_?id)/i;

const TOKEN_PATTERN = /\b(?:bb_live_|github_pat_|gh[pousr]_|sk-(?:proj-)?|nvapi-|vcp_)[a-zA-Z0-9_.-]{8,}\b/g;
const ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|secret|password|private[_-]?key|project[_-]?id)[\\"']*\s*[:=]\s*[\\"']*)([^\\"'\s,}]{6,})/gi;

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
    .replace(TOKEN_PATTERN, "[REDACTED_TOKEN]")
    .replace(ASSIGNMENT_PATTERN, "$1[REDACTED]");
}
