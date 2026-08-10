import { createHash } from "node:crypto";
import { redactSensitiveText } from "./secret-redaction";

export const MAX_LOCAL_HANDOVER_PROMPT_CHARS = 6_000;

export type PromptCaptureMethod = "registered_task" | "codex_app_server" | "claude_user_prompt_hook";

export type LocalHandoverPromptContext = Readonly<{
  initialUserPrompt: string;
  latestUserPrompt?: string;
  captureMethod: PromptCaptureMethod;
  latestCapturedAt?: number;
  digest: string;
}>;

function boundCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  return points.length <= maximum
    ? value
    : `${points.slice(0, maximum).join("")}\n[truncated]`;
}

export function normaliseLocalHandoverPrompt(
  value: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  maximum = MAX_LOCAL_HANDOVER_PROMPT_CHARS,
): string {
  const normalised = String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // Preserve tabs and line breaks, but remove terminal control bytes before
    // treating a prompt as data for another native CLI.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return boundCodePoints(redactSensitiveText(normalised, environment).trim(), maximum);
}

export function localHandoverPromptDigest(initialUserPrompt: string, latestUserPrompt?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ initialUserPrompt, latestUserPrompt: latestUserPrompt ?? null }))
    .digest("hex");
}

export function createLocalHandoverPromptContext(input: Readonly<{
  initialUserPrompt: string;
  latestUserPrompt?: string;
  captureMethod: PromptCaptureMethod;
  latestCapturedAt?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}>): LocalHandoverPromptContext {
  const initialUserPrompt = normaliseLocalHandoverPrompt(input.initialUserPrompt, input.environment);
  const latestUserPrompt = input.latestUserPrompt
    ? normaliseLocalHandoverPrompt(input.latestUserPrompt, input.environment)
    : undefined;
  return {
    initialUserPrompt,
    latestUserPrompt: latestUserPrompt || undefined,
    captureMethod: input.captureMethod,
    latestCapturedAt: input.latestCapturedAt,
    digest: localHandoverPromptDigest(initialUserPrompt, latestUserPrompt || undefined),
  };
}

export function markdownDataBlock(value: string): string {
  const longestExistingFence = [...value.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longestExistingFence + 1));
  return `${fence}text\n${value}\n${fence}`;
}
