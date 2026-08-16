#!/usr/bin/env npx tsx
/*
 * Global Claude UserPromptSubmit hook. It forwards only a bounded hook payload
 * over stdin to the handover supervisor so user text never appears in a
 * process command line. Fail open: normal Claude use must not depend on the
 * handover registry being available.
 */

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 96 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type HookInput = Readonly<{
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  cwd: string;
  prompt: string;
}>;

async function readInput(): Promise<HookInput | null> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<HookInput>;
    if (value?.hook_event_name !== "UserPromptSubmit" || !UUID.test(value.session_id ?? "")
      || typeof value.cwd !== "string" || typeof value.prompt !== "string") return null;
    return value as HookInput;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // Global Claude hooks run for every local conversation. Registration is
  // intentionally opt-in so an ordinary Claude task cannot become eligible
  // for provider routing merely because the handover service is installed.
  if (process.env.JARVIS_ENABLE_GLOBAL_CLAUDE_HANDOVER_REGISTRATION !== "1") return;
  const input = await readInput();
  if (!input) return;
  const cwd = await realpath(input.cwd).catch(() => null);
  if (!cwd || !resolve(cwd).startsWith("/")) return;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(join(root, "node_modules", ".bin", "tsx"), [
    join(root, "scripts", "local-handover-supervisor.ts"),
    "record-claude-prompt",
    "--session-id", input.session_id,
    "--cwd", cwd,
  ], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.stdin.end(JSON.stringify({ ...input, cwd }));
  await new Promise<void>((resolveChild) => {
    child.once("error", resolveChild);
    child.once("close", () => resolveChild());
  });
}

void main().catch(() => {});
