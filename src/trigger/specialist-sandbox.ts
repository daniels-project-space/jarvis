import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants as fsConstants,
  accessSync,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { buildPrivateProcNamespaceInvocation } from "./codex-launcher";

const SYNTHETIC_CODEX_TOKEN = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.synthetic";
const REQUIRED_TOOLS = ["node", "npm", "npx", "git", "gh", "curl"] as const;
const RECEIPT_PROTOCOL = 1;
const RECEIPT_KIND = "jarvis-specialist-namespace-preflight";
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_RECEIPT_AGE_MS = 30_000;
export const SPECIALIST_PROBE_PRLIMIT_COMMAND = "/usr/bin/prlimit";
export const SPECIALIST_PROBE_PRLIMIT_ARGS = Object.freeze([
  `--fsize=${MAX_RECEIPT_BYTES}:${MAX_RECEIPT_BYTES}`,
  "--",
] as const);
const consumedReceiptNonces = new Set<string>();

export type NamespaceProbeLifecycleEvent =
  | "spawn"
  | "stdout-fd-closed"
  | "error"
  | "timeout"
  | "close"
  | "receipt-read"
  | "receipt-validated"
  | "receipt-cleanup";

export type NamespaceProbeInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  nonce: string;
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
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const nonce = String(process.env.JARVIS_NAMESPACE_PROBE_NONCE || "");
const outerPid = String(process.env.JARVIS_NAMESPACE_CONTROLLER_PID || "");
if (!/^[a-f0-9]{64}$/.test(nonce) || !/^[1-9][0-9]*$/.test(outerPid)) process.exit(70);
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
const trustedToolIdentity = (tool) => {
  const searchPath = String(process.env.PATH || "");
  const directories = searchPath.split(path.delimiter);
  if (!searchPath || directories.some((directory) => !directory || !path.isAbsolute(directory))) return "";
  for (const directory of directories) {
    const candidate = path.join(directory, tool);
    try { fs.accessSync(candidate, fs.constants.X_OK); } catch { continue; }
    try {
      // Stop at the first executable PATH entry, matching spawn's lookup. An
      // untrusted first match must fail closed rather than attest a later tool.
      const canonical = fs.realpathSync(candidate);
      const stat = fs.lstatSync(canonical);
      if (
        !path.isAbsolute(canonical)
        || fs.realpathSync(canonical) !== canonical
        || !stat.isFile()
        || stat.uid !== 0
        || (stat.mode & 0o022) !== 0
      ) return "";
      fs.accessSync(canonical, fs.constants.X_OK);
      if (canonical.length <= 160) return canonical;
      return "sha256:" + createHash("sha256").update(fs.readFileSync(canonical)).digest("hex");
    } catch {
      return "";
    }
  }
  return "";
};
const tools = Object.fromEntries(${JSON.stringify(REQUIRED_TOOLS)}.map((tool) => {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 3000 });
  const output = [result.stdout, result.stderr]
    .map((value) => String(value || "").trim().replace(/\s+/g, " "))
    .find(Boolean) || "";
  const version = output
    ? output.slice(0, 160)
    : result.status === 0
      ? trustedToolIdentity(tool)
      : "";
  return [tool, {
    available: result.status === 0 && version.length > 0,
    version,
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
const encoded = JSON.stringify(receipt);
if (Buffer.byteLength(encoded, "utf8") > ${MAX_RECEIPT_BYTES}) process.exit(71);
process.stdout.write(encoded);
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

type NamespaceReceiptFile = {
  root: string;
  path: string;
  fd: number;
  device: number;
  inode: number;
};

function pathIsInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function assertControllerOwned(stat: Stats, label: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not controller-owned`);
  }
}

function createNamespaceReceiptFile(childWorkspace: string): NamespaceReceiptFile {
  const workspace = realpathSync(childWorkspace);
  const temporaryRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, "jarvis-namespace-receipt-"));
  let fd = -1;
  try {
    chmodSync(root, 0o700);
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o777) !== 0o700) {
      throw new Error("namespace receipt state must be a private non-symlink directory");
    }
    assertControllerOwned(rootStat, "namespace receipt state");
    const canonicalRoot = realpathSync(root);
    if (pathIsInside(workspace, canonicalRoot)) {
      throw new Error("namespace receipt state must be outside the child workspace");
    }

    const path = join(canonicalRoot, "receipt.json");
    fd = openSync(path, "wx", 0o600);
    fchmodSync(fd, 0o600);
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile() || fileStat.nlink !== 1 || (fileStat.mode & 0o777) !== 0o600) {
      throw new Error("namespace receipt must be a unique mode-0600 regular file");
    }
    assertControllerOwned(fileStat, "namespace receipt");
    return { root: canonicalRoot, path, fd, device: fileStat.dev, inode: fileStat.ino };
  } catch (error) {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* best-effort cleanup before any child exists */ }
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function readNamespaceProbeReceipt(
  path: string,
  expectedIdentity?: Readonly<{ device: number; inode: number }>,
): string {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw new Error("namespace preflight no-follow boundary is unavailable");
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error("namespace preflight receipt is missing");
    }
    throw new Error("namespace preflight receipt is not a unique mode-0600 regular file");
  }
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
    ) throw new Error("namespace preflight receipt is not a unique mode-0600 regular file");
    assertControllerOwned(before, "namespace preflight receipt");
    if (expectedIdentity && (before.dev !== expectedIdentity.device || before.ino !== expectedIdentity.inode)) {
      throw new Error("namespace preflight receipt identity changed");
    }
    if (before.size < 1) throw new Error("namespace preflight receipt is empty");
    if (before.size > MAX_RECEIPT_BYTES) throw new Error("namespace preflight receipt is oversized");
    const raw = readFileSync(fd, "utf8");
    const bytes = Buffer.byteLength(raw, "utf8");
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.uid !== after.uid
      || before.mode !== after.mode
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes !== before.size
    ) throw new Error("namespace preflight receipt changed during its read");
    if (bytes < 1) throw new Error("namespace preflight receipt is empty");
    if (bytes > MAX_RECEIPT_BYTES) throw new Error("namespace preflight receipt is oversized");
    return raw;
  } finally {
    closeSync(fd);
  }
}

function boundedNamespaceProbeInvocation(invocation: NamespaceProbeInvocation): NamespaceProbeInvocation {
  const stat = lstatSync(SPECIALIST_PROBE_PRLIMIT_COMMAND);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (typeof process.getuid === "function" && stat.uid !== 0)
    || (stat.mode & 0o022) !== 0
    || realpathSync(SPECIALIST_PROBE_PRLIMIT_COMMAND) !== SPECIALIST_PROBE_PRLIMIT_COMMAND
  ) throw new Error("namespace preflight prlimit boundary is unavailable");
  accessSync(SPECIALIST_PROBE_PRLIMIT_COMMAND, fsConstants.X_OK);
  return {
    ...invocation,
    command: SPECIALIST_PROBE_PRLIMIT_COMMAND,
    args: [...SPECIALIST_PROBE_PRLIMIT_ARGS, invocation.command, ...invocation.args],
  };
}

export function validateNamespaceProbeReceipt(input: {
  raw: string;
  expectedNonce: string;
  startedAt: number;
  closedAt: number;
}): NamespaceObservation {
  const receiptBytes = Buffer.byteLength(input.raw, "utf8");
  if (receiptBytes < 1) throw new Error("namespace preflight receipt is empty");
  if (receiptBytes > MAX_RECEIPT_BYTES) throw new Error("namespace preflight receipt is oversized");
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

async function runToClose(
  invocation: NamespaceProbeInvocation,
  timeoutMs: number,
  receipt: NamespaceReceiptFile,
  onLifecycleEvent?: (event: NamespaceProbeLifecycleEvent) => void,
): Promise<{
  code: number | null;
  stdout: string;
  closedAt: number;
  error?: Error;
  receiptError?: Error;
}> {
  const notify = (event: NamespaceProbeLifecycleEvent) => {
    try { onLifecycleEvent?.(event); } catch { /* observations cannot weaken the barrier */ }
  };
  const bounded = boundedNamespaceProbeInvocation(invocation);
  let receiptFdOpen = true;
  let closeObserved = false;
  let closeBarrier: Promise<{ code: number | null; closedAt: number; error?: Error }> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = spawn(bounded.command, bounded.args, {
      cwd: bounded.cwd,
      env: bounded.env,
      stdio: ["ignore", receipt.fd, "pipe"],
      detached: process.platform !== "win32",
    });
    notify("spawn");
    let processError: Error | undefined;
    let timedOut = false;
    closeBarrier = new Promise((resolve) => {
      child!.once("error", (error) => {
        processError = error;
        notify("error");
      });
      child!.once("close", (code) => {
        if (timer) clearTimeout(timer);
        closeObserved = true;
        const closedAt = Date.now();
        notify("close");
        resolve({
          code: timedOut || processError ? -1 : code,
          closedAt,
          error: processError ?? (timedOut ? new Error("namespace preflight timed out") : undefined),
        });
      });
    });

    // Node duplicates this already-open regular file into child FD 1. Closing
    // the controller copy immediately makes child CLOSE the sole read barrier.
    closeSync(receipt.fd);
    receiptFdOpen = false;
    notify("stdout-fd-closed");

    // stderr remains a pipe only so it can be drained. It is never receipt
    // input and therefore cannot influence the security decision.
    child.stderr?.on("data", () => undefined);
    timer = setTimeout(() => {
      timedOut = true;
      notify("timeout");
      if (process.platform !== "win32" && child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group already gone */ }
      }
      try { child?.kill("SIGKILL"); } catch { /* CLOSE remains the barrier */ }
    }, timeoutMs);
    timer.unref?.();

    const terminal = await closeBarrier;
    notify("receipt-read");
    try {
      const stdout = readNamespaceProbeReceipt(receipt.path, {
        device: receipt.device,
        inode: receipt.inode,
      });
      return { ...terminal, stdout };
    } catch (error) {
      return {
        ...terminal,
        stdout: "",
        receiptError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  } finally {
    if (receiptFdOpen) {
      try { closeSync(receipt.fd); } catch { /* no child inherited it if spawn failed synchronously */ }
    }
    if (timer) clearTimeout(timer);
    if (child && !closeObserved && closeBarrier) {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group already gone */ }
      }
      try { child.kill("SIGKILL"); } catch { /* still wait for CLOSE below */ }
      await closeBarrier;
    }
  }
}

/**
 * Build the deterministic preflight exactly as it runs in Trigger: fresh user,
 * mount, PID, and proc namespaces first, then pinned Codex on its existing
 * legacy-Landlock read-only path. The controller supplies an inherited stdout
 * receipt FD separately; no candidate-controlled path enters this argv.
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
  const invocation = buildPrivateProcNamespaceInvocation({
    command: input.codexBin,
    args: [
      "sandbox",
      "-P",
      ":read-only",
      "-c",
      "features.use_legacy_landlock=true",
      "-C",
      cwd,
      "--",
      "/usr/bin/env",
      "-i",
      `PATH=${path}`,
      `HOME=${cwd}`,
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
  return { ...invocation, nonce };
}

/** Run a receipt-only adversary before a specialist lease; uncertainty fails closed. */
export async function verifySpecialistSandboxIsolation(input: {
  codexBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  unshareBinary?: string;
  probeTimeoutMs?: number;
  onLifecycleEvent?: (event: NamespaceProbeLifecycleEvent) => void;
}): Promise<{ ok: true; observation: NamespaceObservation } | { ok: false; reason: string }> {
  let root = "";
  let receipt: NamespaceReceiptFile | undefined;
  try {
    root = mkdtempSync(join(input.cwd, ".jarvis-namespace-probe-"));
    const invocation = buildSpecialistNamespaceProbeInvocation({
      ...input,
      cwd: root,
      controllerPid: process.pid,
    });
    const startedAt = Date.now();
    const timeoutMs = input.probeTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
      throw new Error("namespace preflight timeout is invalid");
    }
    receipt = createNamespaceReceiptFile(root);
    const result = await runToClose(invocation, timeoutMs, receipt, input.onLifecycleEvent);
    if (result.code !== 0 || result.error) {
      return {
        ok: false,
        reason: "specialist legacy-Landlock namespace is unavailable; E2B remains the unactivated provider-neutral fallback",
      };
    }
    if (result.receiptError) throw result.receiptError;
    const observation = validateNamespaceProbeReceipt({
      raw: result.stdout,
      expectedNonce: invocation.nonce,
      startedAt,
      closedAt: result.closedAt,
    });
    input.onLifecycleEvent?.("receipt-validated");
    return { ok: true, observation };
  } catch {
    return {
      ok: false,
      reason: "specialist legacy-Landlock namespace probe failed; E2B remains the unactivated provider-neutral fallback",
    };
  } finally {
    if (receipt) {
      rmSync(receipt.root, { recursive: true, force: true });
      try { input.onLifecycleEvent?.("receipt-cleanup"); } catch { /* observation only */ }
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
