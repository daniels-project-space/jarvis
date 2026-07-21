import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { buildPrivateProcNamespaceInvocation } from "./codex-launcher";

const SYNTHETIC_CODEX_TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.synthetic";
const REQUIRED_TOOLS = ["node", "npm", "npx", "git", "gh", "curl"] as const;
const RECEIPT_PROTOCOL = 1;
const RECEIPT_KIND = "jarvis-specialist-namespace-preflight";
const RECEIPT_NAME = "namespace-preflight-receipt.json";
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_RECEIPT_AGE_MS = 30_000;
const consumedReceiptNonces = new Set<string>();

export type NamespaceProbeInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type ToolObservation = {
  available: boolean;
  version: string;
};

export type NamespaceObservation = {
  protocol: number;
  kind: string;
  nonce: string;
  issuedAt: number;
  controllerVisible: boolean;
  parentReadable: boolean;
  parentTokenVisible: boolean;
  foreignEnvironmentVisible: boolean;
  numericPids: number[];
  selfPid: number;
  tools: Record<string, ToolObservation>;
};

const NAMESPACE_PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const receiptName = String(process.env.JARVIS_NAMESPACE_PROBE_RECEIPT || "");
const nonce = String(process.env.JARVIS_NAMESPACE_PROBE_NONCE || "");
const outerPid = String(process.env.JARVIS_NAMESPACE_CONTROLLER_PID || "");
if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[a-z0-9.-]+$/.test(receiptName)) process.exit(70);
const numericPids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).sort((a, b) => a - b);
let controllerVisible = false;
try { fs.accessSync("/proc/" + outerPid + "/environ"); controllerVisible = true; } catch {}
let parentReadable = false;
let parentTokenVisible = false;
try {
  const parent = fs.readFileSync("/proc/" + process.ppid + "/environ");
  parentReadable = true;
  parentTokenVisible = parent.includes(Buffer.from("CODEX_ACCESS_TOKEN="));
} catch {}
let foreignEnvironmentVisible = false;
for (const pid of numericPids) {
  if (pid === process.pid) continue;
  try {
    const value = fs.readFileSync("/proc/" + pid + "/environ");
    if (value.includes(Buffer.from("CODEX_ACCESS_TOKEN=")) || value.includes(Buffer.from("JARVIS_WORKER_TOKEN="))) {
      foreignEnvironmentVisible = true;
    }
  } catch {}
}
const tools = Object.fromEntries(${JSON.stringify(REQUIRED_TOOLS)}.map((tool) => {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 3000 });
  return [tool, {
    available: result.status === 0,
    version: String(result.stdout || result.stderr || "").trim().replace(/\s+/g, " ").slice(0, 160),
  }];
}));
const receipt = {
  protocol: ${RECEIPT_PROTOCOL},
  kind: ${JSON.stringify(RECEIPT_KIND)},
  nonce,
  issuedAt: Date.now(),
  controllerVisible,
  parentReadable,
  parentTokenVisible,
  foreignEnvironmentVisible,
  numericPids,
  selfPid: process.pid,
  tools,
};
const temporary = receiptName + ".tmp-" + nonce;
const fd = fs.openSync(temporary, "wx", 0o600);
try {
  fs.writeFileSync(fd, JSON.stringify(receipt), "utf8");
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
fs.renameSync(temporary, receiptName);
const directory = fs.openSync(".", "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function rememberNonce(nonce: string): boolean {
  if (consumedReceiptNonces.has(nonce)) return false;
  consumedReceiptNonces.add(nonce);
  if (consumedReceiptNonces.size > 4_096) {
    const oldest = consumedReceiptNonces.values().next().value;
    if (typeof oldest === "string") consumedReceiptNonces.delete(oldest);
  }
  return true;
}

export function validateNamespaceProbeReceipt(input: {
  raw: string;
  expectedNonce: string;
  startedAt: number;
  closedAt: number;
}): NamespaceObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    throw new Error("namespace preflight receipt is malformed");
  }
  if (!isRecord(parsed) || !exactKeys(parsed, [
    "protocol",
    "kind",
    "nonce",
    "issuedAt",
    "controllerVisible",
    "parentReadable",
    "parentTokenVisible",
    "foreignEnvironmentVisible",
    "numericPids",
    "selfPid",
    "tools",
  ])) throw new Error("namespace preflight receipt schema is invalid");
  if (
    parsed.protocol !== RECEIPT_PROTOCOL
    || parsed.kind !== RECEIPT_KIND
    || parsed.nonce !== input.expectedNonce
    || !/^[a-f0-9]{64}$/.test(String(parsed.nonce ?? ""))
    || typeof parsed.issuedAt !== "number"
    || !Number.isSafeInteger(parsed.issuedAt)
    || parsed.issuedAt < input.startedAt - 1_000
    || parsed.issuedAt > input.closedAt + 1_000
    || input.closedAt - parsed.issuedAt > MAX_RECEIPT_AGE_MS
  ) throw new Error("namespace preflight receipt is stale, replayed, or mismatched");
  for (const key of [
    "controllerVisible",
    "parentReadable",
    "parentTokenVisible",
    "foreignEnvironmentVisible",
  ] as const) {
    if (typeof parsed[key] !== "boolean") throw new Error("namespace preflight receipt schema is invalid");
  }
  if (
    !Array.isArray(parsed.numericPids)
    || parsed.numericPids.length < 1
    || parsed.numericPids.length > 24
    || parsed.numericPids.some((pid) => !Number.isInteger(pid) || Number(pid) < 1 || Number(pid) >= 128)
    || !Number.isInteger(parsed.selfPid)
    || !parsed.numericPids.includes(parsed.selfPid)
  ) throw new Error("namespace preflight PID receipt is invalid");
  if (!isRecord(parsed.tools) || !exactKeys(parsed.tools, REQUIRED_TOOLS)) {
    throw new Error("namespace preflight toolchain receipt is invalid");
  }
  for (const tool of REQUIRED_TOOLS) {
    const observed = parsed.tools[tool];
    if (
      !isRecord(observed)
      || !exactKeys(observed, ["available", "version"])
      || observed.available !== true
      || typeof observed.version !== "string"
      || observed.version.length < 1
      || observed.version.length > 160
    ) throw new Error("namespace preflight toolchain receipt is invalid");
  }
  if (
    parsed.controllerVisible
    || parsed.parentReadable
    || parsed.parentTokenVisible
    || parsed.foreignEnvironmentVisible
  ) throw new Error("namespace preflight exposed parent authority");
  if (!rememberNonce(input.expectedNonce)) throw new Error("namespace preflight receipt was replayed");
  return parsed as NamespaceObservation;
}

function readBoundedReceipt(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error("namespace preflight receipt is missing");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("namespace preflight receipt is not a regular file");
  if (stat.size < 1) throw new Error("namespace preflight receipt is empty");
  if (stat.size > MAX_RECEIPT_BYTES) throw new Error("namespace preflight receipt is oversized");
  const fd = openSync(path, "r");
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

async function runToClose(
  invocation: NamespaceProbeInvocation,
  timeoutMs: number,
): Promise<{ code: number | null; error?: Error }> {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let processError: Error | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch { /* close remains the barrier */ }
  }, timeoutMs);
  timer.unref?.();
  return await new Promise((resolve) => {
    child.once("error", (error) => { processError = error; });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : code,
        error: processError ?? (timedOut ? new Error("namespace preflight timed out") : undefined),
      });
    });
  });
}

/**
 * Build the deterministic preflight exactly as it runs in Trigger: fresh user,
 * mount, PID, and proc namespaces first, then pinned Codex on its existing
 * legacy-Landlock path. The probe may write only its fresh workspace receipt.
 */
export function buildSpecialistNamespaceProbeInvocation(input: {
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nonce?: string;
  controllerPid?: number;
  unshareBinary?: string;
}): NamespaceProbeInvocation {
  const cwd = input.cwd;
  const nonce = input.nonce ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("namespace probe nonce is invalid");
  const path = input.env.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    NODE_ENV: input.env.NODE_ENV ?? "production",
    HOME: String(input.env.HOME ?? cwd),
    CODEX_HOME: String(input.env.CODEX_HOME ?? ""),
    CODEX_ACCESS_TOKEN: SYNTHETIC_CODEX_TOKEN,
    LANG: input.env.LANG ?? "C.UTF-8",
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
  return buildPrivateProcNamespaceInvocation({
    command: input.codexBin,
    args: [
      "sandbox",
      "-P",
      ":workspace",
      "-c",
      "features.use_legacy_landlock=true",
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-C",
      cwd,
      "--",
      "/usr/bin/env",
      "-i",
      `PATH=${path}`,
      `HOME=${cwd}`,
      `JARVIS_NAMESPACE_PROBE_RECEIPT=${RECEIPT_NAME}`,
      `JARVIS_NAMESPACE_PROBE_NONCE=${nonce}`,
      `JARVIS_NAMESPACE_CONTROLLER_PID=${String(input.controllerPid ?? process.pid)}`,
      "node",
      "-e",
      NAMESPACE_PROBE_SOURCE,
    ],
    cwd,
    env,
    unshareBinary: input.unshareBinary,
  });
}

/** Run a receipt-only adversary before a specialist lease; uncertainty fails closed. */
export async function verifySpecialistSandboxIsolation(input: {
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  unshareBinary?: string;
}): Promise<{ ok: true; observation: NamespaceObservation } | { ok: false; reason: string }> {
  let root = "";
  try {
    root = mkdtempSync(join(input.cwd, ".jarvis-namespace-probe-"));
    const nonce = randomBytes(32).toString("hex");
    const invocation = buildSpecialistNamespaceProbeInvocation({
      ...input,
      cwd: root,
      nonce,
      controllerPid: process.pid,
    });
    const startedAt = Date.now();
    const result = await runToClose(invocation, 20_000);
    const closedAt = Date.now();
    if (result.code !== 0 || result.error) {
      return {
        ok: false,
        reason: "specialist legacy-Landlock namespace is unavailable; E2B remains the unactivated provider-neutral fallback",
      };
    }
    const raw = readBoundedReceipt(join(root, RECEIPT_NAME));
    const observation = validateNamespaceProbeReceipt({ raw, expectedNonce: nonce, startedAt, closedAt });
    return { ok: true, observation };
  } catch {
    return {
      ok: false,
      reason: "specialist legacy-Landlock namespace probe failed; E2B remains the unactivated provider-neutral fallback",
    };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
