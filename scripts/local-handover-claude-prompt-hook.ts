#!/usr/bin/env npx tsx
/*
 * Claude UserPromptSubmit hook for a single supervisor-owned native session.
 * It intentionally produces no output: a capture failure must never delay or
 * alter the user's Claude prompt.
 */

import { captureClaudeUserPrompt } from "../src/lib/local-handover-claude-prompt-capture";

const MAX_HOOK_INPUT_BYTES = 96 * 1024;

function flags(argv: readonly string[]): ReadonlyMap<string, string> | null {
  if (argv.length % 2 !== 0) return null;
  const output = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || output.has(key)) return null;
    output.set(key, value);
  }
  return output;
}

async function readStdin(): Promise<string | null> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value, "utf8") > MAX_HOOK_INPUT_BYTES) return null;
  }
  return value;
}

async function main(): Promise<void> {
  const parsedFlags = flags(process.argv.slice(2));
  const stateDir = parsedFlags?.get("--state-dir");
  const sessionId = parsedFlags?.get("--session-id");
  if (!stateDir || !sessionId) return;
  const raw = await readStdin();
  if (!raw) return;
  try {
    await captureClaudeUserPrompt(stateDir, sessionId, JSON.parse(raw), process.env);
  } catch {
    // UserPromptSubmit must fail open. Nothing about a prompt is printed.
  }
}

void main();
