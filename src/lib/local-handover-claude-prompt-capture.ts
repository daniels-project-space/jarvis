import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  MAX_LOCAL_HANDOVER_PROMPT_CHARS,
  normaliseLocalHandoverPrompt,
} from "./local-handover-prompt-context";

const MAX_BINDING_BYTES = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UnknownRecord = Record<string, unknown>;

export type ClaudePromptBinding = Readonly<{
  version: 1;
  managedSessionId: string;
  sessionId: string;
  cwd: string;
  bootstrapPromptDigest: string;
  latestUserPrompt?: string;
  latestCapturedAt?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type ClaudeUserPromptHookInput = Readonly<{
  session_id: string;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function validBinding(value: unknown): value is ClaudePromptBinding {
  const binding = record(value);
  const createdAt = Number(binding?.createdAt);
  const updatedAt = Number(binding?.updatedAt);
  return Boolean(binding
    && binding.version === 1
    && typeof binding.managedSessionId === "string" && binding.managedSessionId.length > 0 && binding.managedSessionId.length <= 64
    && typeof binding.sessionId === "string" && UUID.test(binding.sessionId)
    && typeof binding.cwd === "string" && isAbsolute(binding.cwd)
    && typeof binding.bootstrapPromptDigest === "string" && /^[a-f0-9]{64}$/i.test(binding.bootstrapPromptDigest)
    && (binding.latestUserPrompt === undefined || (typeof binding.latestUserPrompt === "string" && binding.latestUserPrompt.length <= MAX_LOCAL_HANDOVER_PROMPT_CHARS + 32))
    && (binding.latestCapturedAt === undefined || (Number.isSafeInteger(Number(binding.latestCapturedAt)) && Number(binding.latestCapturedAt) > 0))
    && Number.isSafeInteger(createdAt) && createdAt > 0
    && Number.isSafeInteger(updatedAt) && updatedAt > 0);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bindingDirectory(stateDir: string): string {
  if (!isAbsolute(stateDir)) throw new Error("local handover state directory must be absolute");
  return join(resolve(stateDir), "claude-prompt-bindings");
}

export function claudePromptBindingPath(stateDir: string, sessionId: string): string {
  if (!UUID.test(sessionId)) throw new Error("invalid Claude session id");
  return join(bindingDirectory(stateDir), `${sessionId}.json`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await fs.chmod(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(resolve(path, ".."));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, path);
  await fs.chmod(path, 0o600);
}

async function readBinding(path: string): Promise<ClaudePromptBinding | null> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BINDING_BYTES) return null;
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    return validBinding(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function createClaudePromptBinding(input: Readonly<{
  stateDir: string;
  managedSessionId: string;
  sessionId: string;
  cwd: string;
  bootstrapPrompt: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<ClaudePromptBinding> {
  if (!UUID.test(input.sessionId) || !isAbsolute(input.cwd)) throw new Error("invalid Claude prompt binding");
  const bootstrapPrompt = normaliseLocalHandoverPrompt(input.bootstrapPrompt, input.environment);
  if (!bootstrapPrompt) throw new Error("empty Claude bootstrap prompt");
  const now = Date.now();
  const binding: ClaudePromptBinding = {
    version: 1,
    managedSessionId: input.managedSessionId,
    sessionId: input.sessionId,
    cwd: resolve(input.cwd),
    bootstrapPromptDigest: digest(bootstrapPrompt),
    createdAt: now,
    updatedAt: now,
  };
  await writePrivateJson(claudePromptBindingPath(input.stateDir, input.sessionId), binding);
  return binding;
}

export async function readClaudeLatestUserPrompt(
  stateDir: string,
  sessionId: string,
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<{ prompt?: string; capturedAt?: number } | null> {
  const binding = await readBinding(claudePromptBindingPath(stateDir, sessionId));
  if (!binding) return null;
  const prompt = binding.latestUserPrompt
    ? normaliseLocalHandoverPrompt(binding.latestUserPrompt, environment)
    : "";
  return { prompt: prompt || undefined, capturedAt: binding.latestCapturedAt };
}

export async function captureClaudeUserPrompt(
  stateDir: string,
  expectedSessionId: string,
  value: unknown,
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<"captured" | "ignored"> {
  if (!UUID.test(expectedSessionId)) return "ignored";
  const input = record(value);
  if (input?.hook_event_name !== "UserPromptSubmit"
    || input.session_id !== expectedSessionId
    || typeof input.cwd !== "string"
    || typeof input.prompt !== "string") return "ignored";
  const path = claudePromptBindingPath(stateDir, expectedSessionId);
  const binding = await readBinding(path);
  if (!binding || binding.sessionId !== expectedSessionId || resolve(input.cwd) !== binding.cwd) return "ignored";
  const prompt = normaliseLocalHandoverPrompt(input.prompt, environment);
  if (!prompt || digest(prompt) === binding.bootstrapPromptDigest) return "ignored";
  await writePrivateJson(path, {
    ...binding,
    latestUserPrompt: prompt,
    latestCapturedAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies ClaudePromptBinding);
  return "captured";
}
