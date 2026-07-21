import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const PROVIDER_PATH = "/workspace/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTROLLER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const RECEIPT_PROTOCOL = 1;
const RECEIPT_KIND = "jarvis-provider-command-sandbox-preflight";
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_RECEIPT_AGE_MS = 30_000;
const CREDENTIAL_FILE = /(?:^|[._-])(?:auth|credential|token|secret|password)(?:[._-]|$)|(?:\.pem|\.key)$|^(?:\.netrc|\.git-credentials)$/i;
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
const CAPABILITY_KEYS = ["CONVEX_DEPLOY_KEY", "TRIGGER_ACCESS_TOKEN"] as const;
const consumedReceiptNonces = new Set<string>();

export type ProviderCapabilityName = typeof CAPABILITY_KEYS[number];

export type ProviderCommandResult = Readonly<{
  code: number | null;
  out: string;
  receipt: Readonly<{
    protocol: 1;
    candidateSandbox: true;
    executable: "node" | "npm" | "npx";
    argv: readonly string[];
    commandDigest: string;
    startedAt: number;
    closedAt: number;
    closeObserved: true;
    timedOut: boolean;
    capability: ProviderCapabilityName | "none";
  }>;
}>;

export type ProviderToolSession = Readonly<{
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}>;

export type ProviderSandboxObservation = Readonly<{
  protocol: number;
  kind: string;
  nonce: string;
  issuedAt: number;
  selfPid: number;
  numericPids: number[];
  capabilities: { effective: string; bounding: string; ambient: string; noNewPrivs: boolean };
  authority: {
    outsideCredentialReadable: boolean;
    outsideCredentialEchoed: boolean;
    outsideWriteBlocked: boolean;
    rootMemoryReadable: boolean;
    foreignCheckoutReadable: boolean;
    parentEnvironmentAuthorityVisible: boolean;
    workspaceWriteSucceeded: boolean;
    runtimeWriteBlocked: boolean;
    symlinkEscapeBlocked: boolean;
    chrootBlocked: boolean;
    mountBlocked: boolean;
    capabilityRegainBlocked: boolean;
    gitMetadataWriteBlocked: boolean;
  };
  network: { policy: string; namespace: string; expectedNamespace: string };
  tools: Record<string, { available: boolean; version: string }>;
}>;

type RuntimePaths = Readonly<{
  unshare: string;
  mount: string;
  chroot: string;
  capsh: string;
  env: string;
  shell: string;
  usr: string;
  bin: string;
  lib: string;
  lib64: string;
  etc: string;
  devNull: string;
  devZero: string;
  devRandom: string;
  devUrandom: string;
}>;

const DEFAULT_RUNTIME_PATHS: RuntimePaths = Object.freeze({
  unshare: "/usr/bin/unshare",
  mount: "/usr/bin/mount",
  chroot: "/usr/sbin/chroot",
  capsh: "/usr/sbin/capsh",
  env: "/usr/bin/env",
  shell: "/bin/sh",
  usr: "/usr",
  bin: "/bin",
  lib: "/lib",
  lib64: "/lib64",
  etc: "/etc",
  devNull: "/dev/null",
  devZero: "/dev/zero",
  devRandom: "/dev/random",
  devUrandom: "/dev/urandom",
});

/**
 * Fixed setup code. Every variable is a controller-validated argv element;
 * candidate command text is never evaluated by this shell.
 */
export const PROVIDER_SANDBOX_SETUP = `#!/usr/bin/dash
set -efu
rootfs=$1
workspace=$2
usr_source=$3
bin_source=$4
lib_source=$5
lib64_source=$6
etc_source=$7
dev_null=$8
dev_zero=$9
shift 9
dev_random=$1
dev_urandom=$2
shift 2

readonly_bind() {
  source_path=$1
  destination_path=$2
  /usr/bin/mount --bind "$source_path" "$destination_path"
  /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$destination_path"
}

readonly_bind "$usr_source" "$rootfs/usr"
readonly_bind "$bin_source" "$rootfs/bin"
readonly_bind "$lib_source" "$rootfs/lib"
readonly_bind "$lib64_source" "$rootfs/lib64"
readonly_bind "$etc_source" "$rootfs/etc"
/usr/bin/mount --bind "$workspace" "$rootfs/workspace"
/usr/bin/mount -o remount,bind,rw,nosuid,nodev "$rootfs/workspace"
/usr/bin/mount --bind "$workspace/.git" "$rootfs/workspace/.git"
/usr/bin/mount -o remount,bind,ro,nosuid,nodev "$rootfs/workspace/.git"
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc "$rootfs/proc"
readonly_bind "$dev_null" "$rootfs/dev/null"
readonly_bind "$dev_zero" "$rootfs/dev/zero"
readonly_bind "$dev_random" "$rootfs/dev/random"
readonly_bind "$dev_urandom" "$rootfs/dev/urandom"

exec /usr/sbin/chroot "$rootfs" /usr/sbin/capsh \
  --drop=all --caps= --inh= --noamb --no-new-privs -- \
  -c 'exec /usr/bin/env -i \
    PATH="$JARVIS_PROVIDER_PATH" \
    HOME=/home/provider \
    CODEX_HOME=/home/provider/.codex \
    XDG_CONFIG_HOME=/home/provider/.config \
    XDG_CACHE_HOME=/home/provider/.cache \
    TMPDIR=/tmp \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 TERM=dumb FORCE_COLOR=0 \
    NPM_CONFIG_USERCONFIG=/home/provider/.npmrc \
    NPM_CONFIG_CACHE=/home/provider/.npm-cache \
    NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/home/provider/.gitconfig \
    GIT_CONFIG_COUNT=4 \
    GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
    GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= \
    GIT_CONFIG_KEY_2=core.fsmonitor GIT_CONFIG_VALUE_2=false \
    GIT_CONFIG_KEY_3=core.untrackedCache GIT_CONFIG_VALUE_3=false \
    GIT_TERMINAL_PROMPT=0 GH_PROMPT_DISABLED=1 GH_CONFIG_DIR=/home/provider/.config/gh \
    HTTP_PROXY="\${HTTP_PROXY-}" HTTPS_PROXY="\${HTTPS_PROXY-}" NO_PROXY="\${NO_PROXY-}" \
    http_proxy="\${http_proxy-}" https_proxy="\${https_proxy-}" no_proxy="\${no_proxy-}" \
    CONVEX_DEPLOY_KEY="\${CONVEX_DEPLOY_KEY-}" \
    TRIGGER_ACCESS_TOKEN="\${TRIGGER_ACCESS_TOKEN-}" \
    JARVIS_PROVIDER_PROBE_NONCE="\${JARVIS_PROVIDER_PROBE_NONCE-}" \
    JARVIS_PROVIDER_PROBE_RECEIPT="\${JARVIS_PROVIDER_PROBE_RECEIPT-}" \
    JARVIS_PROVIDER_PROBE_OUTSIDE="\${JARVIS_PROVIDER_PROBE_OUTSIDE-}" \
    JARVIS_PROVIDER_PROBE_CONTROLLER_PID="\${JARVIS_PROVIDER_PROBE_CONTROLLER_PID-}" \
    JARVIS_PROVIDER_PROBE_NETWORK_NS="\${JARVIS_PROVIDER_PROBE_NETWORK_NS-}" \
    /controller/run-candidate "$@"' provider-sandbox "$@"
`;

const RUN_CANDIDATE = `#!/usr/bin/dash
set -efu
cd /workspace
exec "$@"
`;

const PREFLIGHT_SOURCE = String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const nonce = String(process.env.JARVIS_PROVIDER_PROBE_NONCE || "");
const receiptPath = String(process.env.JARVIS_PROVIDER_PROBE_RECEIPT || "");
const outsidePath = String(process.env.JARVIS_PROVIDER_PROBE_OUTSIDE || "");
const controllerPid = String(process.env.JARVIS_PROVIDER_PROBE_CONTROLLER_PID || "");
const expectedNetworkNamespace = String(process.env.JARVIS_PROVIDER_PROBE_NETWORK_NS || "");
if (!/^[a-f0-9]{64}$/.test(nonce) || !/^\.jarvis-provider-probe-[^/]+\/receipt\.json$/.test(receiptPath)) process.exit(70);
const sentinel = "jarvis-synthetic-controller-credential-" + nonce;
const numericPids = fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).map(Number).sort((a, b) => a - b);
const status = fs.readFileSync("/proc/self/status", "utf8");
const statusValue = (name) => (status.match(new RegExp("^" + name + ":\\s*([^\\s]+)", "m")) || [])[1] || "";
const blockedRead = (path) => { try { fs.readFileSync(path); return false; } catch { return true; } };
const blockedWrite = (path) => { try { fs.writeFileSync(path, "must-not-write"); return false; } catch { return true; } };
let outsideCredentialReadable = false;
let outsideCredentialEchoed = false;
try {
  const value = fs.readFileSync(outsidePath, "utf8");
  outsideCredentialReadable = true;
  outsideCredentialEchoed = value.includes(sentinel);
} catch {}
let parentEnvironmentAuthorityVisible = false;
for (const pid of numericPids) {
  if (pid === process.pid) continue;
  try {
    const value = fs.readFileSync("/proc/" + pid + "/environ");
    if (/(?:VAULT_ACCESS_TOKEN|GITHUB_TOKEN|JARVIS_WORKER_TOKEN|CODEX_ACCESS_TOKEN)=/.test(value.toString("utf8"))) {
      parentEnvironmentAuthorityVisible = true;
    }
  } catch {}
}
try {
  const value = fs.readFileSync("/proc/" + controllerPid + "/environ");
  if (value.length) parentEnvironmentAuthorityVisible = true;
} catch {}
let workspaceWriteSucceeded = false;
try {
  const path = receiptPath.replace(/receipt\.json$/, "workspace-write");
  fs.writeFileSync(path, "ok");
  workspaceWriteSucceeded = fs.readFileSync(path, "utf8") === "ok";
  fs.unlinkSync(path);
} catch {}
const tools = Object.fromEntries(["node", "npm", "npx", "git", "gh", "curl"].map((tool) => {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 3000 });
  return [tool, {
    available: result.status === 0,
    version: String(result.stdout || result.stderr || "").trim().replace(/\s+/g, " ").slice(0, 160),
  }];
}));
const networkNamespace = fs.readlinkSync("/proc/self/ns/net");
const receipt = {
  protocol: ${RECEIPT_PROTOCOL},
  kind: ${JSON.stringify(RECEIPT_KIND)},
  nonce,
  issuedAt: Date.now(),
  selfPid: process.pid,
  numericPids,
  capabilities: {
    effective: statusValue("CapEff"),
    bounding: statusValue("CapBnd"),
    ambient: statusValue("CapAmb"),
    noNewPrivs: statusValue("NoNewPrivs") === "1",
  },
  authority: {
    outsideCredentialReadable,
    outsideCredentialEchoed,
    outsideWriteBlocked: blockedWrite(outsidePath + ".write"),
    rootMemoryReadable: !blockedRead("/root/CODEX_MEMORY/INDEX.md"),
    foreignCheckoutReadable: !blockedRead("/home/ubuntu/jarvis/package.json"),
    parentEnvironmentAuthorityVisible,
    workspaceWriteSucceeded,
    runtimeWriteBlocked: blockedWrite("/usr/.jarvis-provider-runtime-write"),
    symlinkEscapeBlocked: blockedRead(receiptPath.replace(/receipt\.json$/, "outside-link")),
    chrootBlocked: spawnSync("/usr/sbin/chroot", ["/", "/bin/true"]).status !== 0,
    mountBlocked: spawnSync("/usr/bin/mount", ["-t", "tmpfs", "tmpfs", "/tmp"]).status !== 0,
    capabilityRegainBlocked: spawnSync("/usr/sbin/capsh", ["--caps=cap_sys_admin+ep", "--", "-c", "true"]).status !== 0,
    gitMetadataWriteBlocked: blockedWrite(".git/config"),
  },
  network: {
    policy: "target-egress-allowed",
    namespace: networkNamespace,
    expectedNamespace: expectedNetworkNamespace,
  },
  tools,
};
const temporary = receiptPath + ".tmp-" + nonce;
const fd = fs.openSync(temporary, "wx", 0o600);
try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(temporary, receiptPath);
const directory = fs.openSync(receiptPath.replace(/\/receipt\.json$/, ""), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
`;

function canonicalExisting(path: string, kind: "file" | "directory" | "device", label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  let canonical: string;
  try { canonical = realpathSync(path); } catch { throw new Error(`${label} is unavailable`); }
  const stat = lstatSync(canonical);
  if (stat.isSymbolicLink()) throw new Error(`${label} resolved to a symlink`);
  if (kind === "file" && !stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (kind === "device" && !stat.isCharacterDevice()) throw new Error(`${label} must be a character device`);
  return canonical;
}

function canonicalCheckout(path: string): string {
  if (!isAbsolute(path)) throw new Error("candidate checkout must be absolute");
  const lexical = lstatSync(path);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error("candidate checkout must be a non-symlink directory");
  const canonical = realpathSync(path);
  const git = lstatSync(join(canonical, ".git"));
  if (git.isSymbolicLink() || !git.isDirectory()) throw new Error("candidate Git metadata must be a non-symlink directory");
  return canonical;
}

function validateProxy(name: string, value: string): void {
  if (!/proxy/i.test(name) || !value) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`invalid provider tool proxy URL ${name}`); }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) throw new Error(`credential-bearing or non-canonical provider tool proxy URL ${name} is forbidden`);
}

function assertSessionTree(root: string): void {
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > 10_000) throw new Error("provider tool state exceeds its inspection boundary");
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("provider tool state contains a symlink");
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stat.isFile()) throw new Error("provider tool state contains an unexpected filesystem object");
      if (entry.name === ".npmrc" || entry.name === ".gitconfig") {
        if (stat.size !== 0) throw new Error("provider tool config files must remain empty");
      } else if (CREDENTIAL_FILE.test(entry.name)) {
        throw new Error("provider tool state contains credential-looking material");
      }
    }
  }
}

/** Create one fresh, controller-owned, credentialless tool state per release. */
export function createProviderToolSession(base: NodeJS.ProcessEnv): ProviderToolSession {
  const root = mkdtempSync(join(tmpdir(), "jarvis-provider-session-"));
  const home = join(root, "home");
  const config = join(root, "xdg-config");
  const cache = join(root, "xdg-cache");
  const npmCache = join(root, "npm-cache");
  const temp = join(root, "tmp");
  const codexHome = join(root, "codex-home");
  for (const directory of [home, config, cache, npmCache, temp, codexHome]) mkdirSync(directory, { mode: 0o700 });
  const npmrc = join(root, ".npmrc");
  const gitconfig = join(root, ".gitconfig");
  writeFileSync(npmrc, "", { mode: 0o600 });
  writeFileSync(gitconfig, "", { mode: 0o600 });
  const env = {} as NodeJS.ProcessEnv;
  for (const key of PROXY_KEYS) {
    const value = base[key];
    if (value === undefined) continue;
    validateProxy(key, value);
    env[key] = value;
  }
  env.PATH = CONTROLLER_PATH;
  env.HOME = home;
  env.CODEX_HOME = codexHome;
  env.XDG_CONFIG_HOME = config;
  env.XDG_CACHE_HOME = cache;
  env.TMPDIR = temp;
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  env.CI = "1";
  env.NPM_CONFIG_USERCONFIG = npmrc;
  env.NPM_CONFIG_CACHE = npmCache;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = gitconfig;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  let cleaned = false;
  return Object.freeze({
    root,
    home,
    env,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
    },
  });
}

/** Return a copy only after revalidating the fresh state. Controller HOME is never retained. */
export function safeProviderToolEnv(
  base: NodeJS.ProcessEnv,
  session: ProviderToolSession,
): NodeJS.ProcessEnv {
  for (const key of PROXY_KEYS) {
    const value = base[key];
    if (value !== undefined) validateProxy(key, value);
  }
  const root = canonicalExisting(session.root, "directory", "provider tool state");
  const home = canonicalExisting(session.home, "directory", "provider tool HOME");
  if (root !== realpathSync(session.root) || !home.startsWith(`${root}${sep}`)) {
    throw new Error("provider tool HOME escaped its controller-owned state");
  }
  assertSessionTree(root);
  return { ...session.env };
}

function runtimePaths(input: Partial<RuntimePaths> = {}): RuntimePaths {
  const raw = { ...DEFAULT_RUNTIME_PATHS, ...input };
  return Object.freeze({
    unshare: canonicalExisting(raw.unshare, "file", "unshare executable"),
    mount: canonicalExisting(raw.mount, "file", "mount executable"),
    chroot: canonicalExisting(raw.chroot, "file", "chroot executable"),
    capsh: canonicalExisting(raw.capsh, "file", "capsh executable"),
    env: canonicalExisting(raw.env, "file", "env executable"),
    shell: canonicalExisting(raw.shell, "file", "namespace setup shell"),
    usr: canonicalExisting(raw.usr, "directory", "runtime /usr"),
    bin: canonicalExisting(raw.bin, "directory", "runtime /bin"),
    lib: canonicalExisting(raw.lib, "directory", "runtime /lib"),
    lib64: canonicalExisting(raw.lib64, "directory", "runtime /lib64"),
    etc: canonicalExisting(raw.etc, "directory", "runtime /etc"),
    devNull: canonicalExisting(raw.devNull, "device", "runtime /dev/null"),
    devZero: canonicalExisting(raw.devZero, "device", "runtime /dev/zero"),
    devRandom: canonicalExisting(raw.devRandom, "device", "runtime /dev/random"),
    devUrandom: canonicalExisting(raw.devUrandom, "device", "runtime /dev/urandom"),
  });
}

function mkdirRootfs(rootfs: string): void {
  for (const directory of [
    "usr", "bin", "lib", "lib64", "etc", "proc", "dev", "workspace",
    "controller", "home", "home/provider", "home/provider/.codex",
    "home/provider/.config", "home/provider/.cache", "home/provider/.npm-cache", "tmp",
  ]) mkdirSync(join(rootfs, directory), { recursive: true, mode: 0o700 });
  for (const file of ["null", "zero", "random", "urandom"]) writeFileSync(join(rootfs, "dev", file), "", { mode: 0o600 });
  writeFileSync(join(rootfs, "home/provider/.npmrc"), "", { mode: 0o600 });
  writeFileSync(join(rootfs, "home/provider/.gitconfig"), "", { mode: 0o600 });
  const runner = join(rootfs, "controller/run-candidate");
  writeFileSync(runner, RUN_CANDIDATE, { mode: 0o500 });
  chmodSync(runner, 0o500);
}

function toolInsidePath(command: string): string {
  const paths: Record<string, string> = {
    node: "/usr/local/bin/node",
    npm: "/usr/local/bin/npm",
    npx: "/usr/local/bin/npx",
  };
  const selected = paths[command];
  if (!selected) throw new Error(`provider sandbox command ${command} is not allowlisted`);
  const canonical = canonicalExisting(selected, "file", `provider ${command} executable`);
  if (!canonical.startsWith("/usr/")) throw new Error(`provider ${command} executable is outside the read-only runtime`);
  return selected;
}

function strictCandidateEnv(input: {
  base: NodeJS.ProcessEnv;
  capability?: { name: ProviderCapabilityName; value: string };
  probe?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    PATH: CONTROLLER_PATH,
    JARVIS_PROVIDER_PATH: PROVIDER_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const key of PROXY_KEYS) {
    const value = input.base[key];
    if (value === undefined) continue;
    validateProxy(key, value);
    env[key] = value;
  }
  if (input.capability) {
    if (!CAPABILITY_KEYS.includes(input.capability.name) || !input.capability.value.trim()) {
      throw new Error("provider sandbox capability is invalid");
    }
    env[input.capability.name] = input.capability.value;
  }
  for (const [key, value] of Object.entries(input.probe ?? {})) {
    if (!/^JARVIS_PROVIDER_PROBE_[A-Z_]+$/.test(key)) throw new Error("provider probe environment key is invalid");
    env[key] = value;
  }
  return env;
}

function redact(output: string, secrets: readonly string[]): string {
  let redacted = output;
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rememberReceiptNonce(nonce: string): void {
  if (consumedReceiptNonces.has(nonce)) throw new Error("provider sandbox receipt was replayed");
  consumedReceiptNonces.add(nonce);
  if (consumedReceiptNonces.size > 4_096) {
    const oldest = consumedReceiptNonces.values().next().value;
    if (typeof oldest === "string") consumedReceiptNonces.delete(oldest);
  }
}

export function validateProviderSandboxReceipt(input: {
  raw: string;
  nonce: string;
  startedAt: number;
  closedAt: number;
}): ProviderSandboxObservation {
  let parsed: unknown;
  try { parsed = JSON.parse(input.raw); } catch { throw new Error("provider sandbox receipt is malformed"); }
  if (!isRecord(parsed) || !exactObjectKeys(parsed, [
    "protocol", "kind", "nonce", "issuedAt", "selfPid", "numericPids",
    "capabilities", "authority", "network", "tools",
  ])) throw new Error("provider sandbox receipt schema is invalid");
  if (
    parsed.protocol !== RECEIPT_PROTOCOL
    || parsed.kind !== RECEIPT_KIND
    || parsed.nonce !== input.nonce
    || !/^[a-f0-9]{64}$/.test(String(parsed.nonce ?? ""))
    || !Number.isSafeInteger(parsed.issuedAt)
    || Number(parsed.issuedAt) < input.startedAt - 1_000
    || Number(parsed.issuedAt) > input.closedAt + 1_000
    || input.closedAt - Number(parsed.issuedAt) > MAX_RECEIPT_AGE_MS
  ) throw new Error("provider sandbox receipt is stale or mismatched");
  if (
    !Number.isInteger(parsed.selfPid)
    || !Array.isArray(parsed.numericPids)
    || parsed.numericPids.length < 1
    || parsed.numericPids.length > 24
    || parsed.numericPids.some((pid) => !Number.isInteger(pid) || Number(pid) < 1 || Number(pid) >= 128)
    || !parsed.numericPids.includes(parsed.selfPid)
  ) throw new Error("provider sandbox PID receipt is invalid");
  if (!isRecord(parsed.capabilities) || !exactObjectKeys(parsed.capabilities, ["effective", "bounding", "ambient", "noNewPrivs"])) {
    throw new Error("provider sandbox capability receipt is invalid");
  }
  if (
    ![parsed.capabilities.effective, parsed.capabilities.bounding, parsed.capabilities.ambient]
      .every((value) => typeof value === "string" && /^0+$/.test(value))
    || parsed.capabilities.noNewPrivs !== true
  ) throw new Error("provider sandbox retained process capabilities");
  const authorityKeys = [
    "outsideCredentialReadable", "outsideCredentialEchoed", "outsideWriteBlocked",
    "rootMemoryReadable", "foreignCheckoutReadable", "parentEnvironmentAuthorityVisible",
    "workspaceWriteSucceeded", "runtimeWriteBlocked", "symlinkEscapeBlocked",
    "chrootBlocked", "mountBlocked", "capabilityRegainBlocked", "gitMetadataWriteBlocked",
  ] as const;
  if (!isRecord(parsed.authority) || !exactObjectKeys(parsed.authority, authorityKeys)) {
    throw new Error("provider sandbox authority receipt is invalid");
  }
  for (const key of authorityKeys) {
    if (typeof parsed.authority[key] !== "boolean") throw new Error("provider sandbox authority receipt is invalid");
  }
  if (
    parsed.authority.outsideCredentialReadable
    || parsed.authority.outsideCredentialEchoed
    || parsed.authority.rootMemoryReadable
    || parsed.authority.foreignCheckoutReadable
    || parsed.authority.parentEnvironmentAuthorityVisible
    || !parsed.authority.outsideWriteBlocked
    || !parsed.authority.workspaceWriteSucceeded
    || !parsed.authority.runtimeWriteBlocked
    || !parsed.authority.symlinkEscapeBlocked
    || !parsed.authority.chrootBlocked
    || !parsed.authority.mountBlocked
    || !parsed.authority.capabilityRegainBlocked
    || !parsed.authority.gitMetadataWriteBlocked
  ) throw new Error("provider sandbox authority boundary failed");
  if (
    !isRecord(parsed.network)
    || !exactObjectKeys(parsed.network, ["policy", "namespace", "expectedNamespace"])
    || parsed.network.policy !== "target-egress-allowed"
    || typeof parsed.network.namespace !== "string"
    || parsed.network.namespace !== parsed.network.expectedNamespace
    || !/^net:\[\d+\]$/.test(parsed.network.namespace)
  ) throw new Error("provider sandbox network policy receipt is invalid");
  if (!isRecord(parsed.tools) || !exactObjectKeys(parsed.tools, ["node", "npm", "npx", "git", "gh", "curl"])) {
    throw new Error("provider sandbox toolchain receipt is invalid");
  }
  for (const value of Object.values(parsed.tools)) {
    if (
      !isRecord(value)
      || !exactObjectKeys(value, ["available", "version"])
      || value.available !== true
      || typeof value.version !== "string"
      || value.version.length < 1
      || value.version.length > 160
    ) throw new Error("provider sandbox toolchain receipt is invalid");
  }
  rememberReceiptNonce(input.nonce);
  return parsed as ProviderSandboxObservation;
}

function readReceipt(path: string): string {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error("provider sandbox receipt is missing"); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("provider sandbox receipt is not a regular file");
  if (stat.size < 1) throw new Error("provider sandbox receipt is empty");
  if (stat.size > MAX_RECEIPT_BYTES) throw new Error("provider sandbox receipt is oversized");
  const fd = openSync(path, "r");
  try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
}

export class ProviderCandidateSandbox {
  private readonly checkout: string;
  private readonly setup: string;
  private readonly active = new Set<Promise<ProviderCommandResult>>();
  private paths: RuntimePaths | undefined;
  private preflightObservation: ProviderSandboxObservation | undefined;
  private toolchainReady = false;
  private cleaned = false;

  constructor(private readonly input: {
    checkout: string;
    baseEnv: NodeJS.ProcessEnv;
    session: ProviderToolSession;
    runtimePaths?: Partial<RuntimePaths>;
  }) {
    this.checkout = canonicalCheckout(input.checkout);
    const rel = relative(this.checkout, input.session.root);
    if (!rel.startsWith("..") || rel === "") throw new Error("provider sandbox root must live outside the candidate checkout");
    this.setup = join(input.session.root, "provider-sandbox-setup");
    writeFileSync(this.setup, PROVIDER_SANDBOX_SETUP, { mode: 0o500 });
    chmodSync(this.setup, 0o500);
  }

  private getPaths(): RuntimePaths {
    this.paths ??= runtimePaths(this.input.runtimePaths);
    return this.paths;
  }

  private runInternal(input: {
    command: "node" | "npm" | "npx";
    args: readonly string[];
    timeoutMs: number;
    capability?: { name: ProviderCapabilityName; value: string };
    probe?: Record<string, string>;
    allowBeforePreflight?: boolean;
  }): Promise<ProviderCommandResult> {
    if (this.cleaned) return Promise.reject(new Error("provider sandbox is already cleaned"));
    if (!input.allowBeforePreflight && !this.preflightObservation) {
      return Promise.reject(new Error("provider sandbox command was attempted before preflight closed"));
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30 * 60_000) {
      return Promise.reject(new Error("provider sandbox timeout is invalid"));
    }
    const args = input.args.map(String);
    if (args.length > 256 || args.some((arg) => arg.includes("\0") || arg.length > 16_384)) {
      return Promise.reject(new Error("provider sandbox argv exceeds its boundary"));
    }
    let rootfs = "";
    try {
      const paths = this.getPaths();
      rootfs = mkdtempSync(join(this.input.session.root, "rootfs-"));
      if (resolve(rootfs).startsWith(`${resolve(this.checkout)}${sep}`)) {
        throw new Error("provider sandbox rootfs must not be candidate-writable");
      }
      mkdirRootfs(rootfs);
      const insideCommand = toolInsidePath(input.command);
      const env = strictCandidateEnv({ base: this.input.baseEnv, capability: input.capability, probe: input.probe });
      const invocationArgs = [
        "--user", "--map-root-user", "--mount", "--pid", "--fork", "--kill-child=SIGKILL",
        "--propagation", "unchanged", "--", this.setup, rootfs, this.checkout,
        paths.usr, paths.bin, paths.lib, paths.lib64, paths.etc,
        paths.devNull, paths.devZero, paths.devRandom, paths.devUrandom,
        insideCommand, ...args,
      ];
      const commandDigest = createHash("sha256")
        .update(paths.unshare).update("\0").update(invocationArgs.join("\0"))
        .digest("hex");
      const startedAt = Date.now();
      const child = spawn(paths.unshare, invocationArgs, {
        cwd: this.input.session.root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const secrets = input.capability ? [input.capability.value] : [];
      const promise = new Promise<ProviderCommandResult>((resolveResult) => {
        let output = "";
        let processError: Error | undefined;
        let timedOut = false;
        const append = (chunk: unknown) => { output = `${output}${String(chunk)}`.slice(-256_000); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", (error) => { processError = error; });
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGKILL"); } catch { /* close is still mandatory */ }
        }, input.timeoutMs);
        timer.unref?.();
        child.once("close", (code) => {
          clearTimeout(timer);
          const closedAt = Date.now();
          if (processError) output = `${output}\n${processError.message}`;
          resolveResult(Object.freeze({
            code: timedOut || processError ? -1 : code,
            out: redact(output, secrets),
            receipt: Object.freeze({
              protocol: 1 as const,
              candidateSandbox: true as const,
              executable: input.command,
              argv: Object.freeze([...args]),
              commandDigest,
              startedAt,
              closedAt,
              closeObserved: true as const,
              timedOut,
              capability: input.capability?.name ?? "none",
            }),
          }));
        });
      }).finally(() => {
        rmSync(rootfs, { recursive: true, force: true });
      });
      this.active.add(promise);
      void promise.finally(() => this.active.delete(promise));
      return promise;
    } catch (error) {
      if (rootfs) rmSync(rootfs, { recursive: true, force: true });
      return Promise.reject(error);
    }
  }

  async preflight(): Promise<ProviderSandboxObservation> {
    if (this.preflightObservation) return this.preflightObservation;
    const probe = mkdtempSync(join(this.checkout, ".jarvis-provider-probe-"));
    const probeName = probe.slice(this.checkout.length + 1);
    const receipt = join(probe, "receipt.json");
    const outsideRoot = mkdtempSync("/var/tmp/jarvis-provider-outside-");
    const outside = join(outsideRoot, "controller-credential.txt");
    const nonce = randomBytes(32).toString("hex");
    const source = join(probe, "preflight.cjs");
    writeFileSync(outside, `jarvis-synthetic-controller-credential-${nonce}`, { mode: 0o600 });
    writeFileSync(source, PREFLIGHT_SOURCE, { mode: 0o600 });
    symlinkSync(outside, join(probe, "outside-link"));
    const expectedNetworkNamespace = readlinkSync("/proc/self/ns/net");
    try {
      const startedAt = Date.now();
      const result = await this.runInternal({
        command: "node",
        args: [`.${sep}${probeName}${sep}preflight.cjs`],
        timeoutMs: 25_000,
        allowBeforePreflight: true,
        probe: {
          JARVIS_PROVIDER_PROBE_NONCE: nonce,
          JARVIS_PROVIDER_PROBE_RECEIPT: `${probeName}/receipt.json`,
          JARVIS_PROVIDER_PROBE_OUTSIDE: outside,
          JARVIS_PROVIDER_PROBE_CONTROLLER_PID: String(process.pid),
          JARVIS_PROVIDER_PROBE_NETWORK_NS: expectedNetworkNamespace,
        },
      });
      const closedAt = result.receipt.closedAt;
      if (result.code !== 0 || !result.receipt.closeObserved) {
        throw new Error(`provider sandbox preflight failed: ${result.out.trim().slice(-500) || `exit ${String(result.code)}`}`);
      }
      this.preflightObservation = validateProviderSandboxReceipt({
        raw: readReceipt(receipt),
        nonce,
        startedAt,
        closedAt,
      });
      return this.preflightObservation;
    } finally {
      rmSync(probe, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  }

  async verifyPinnedToolchain(): Promise<void> {
    if (this.toolchainReady) return;
    if (!this.preflightObservation) throw new Error("provider toolchain check requires a closed sandbox preflight");
    for (const [tool, args] of [
      ["TypeScript", ["--no-install", "tsc", "--version"]],
      ["Convex", ["--no-install", "convex", "--version"]],
      ["Trigger", ["--no-install", "trigger.dev", "--version"]],
    ] as const) {
      const result = await this.runInternal({ command: "npx", args, timeoutMs: 60_000 });
      if (result.code !== 0 || !result.out.trim()) throw new Error(`pinned ${tool} CLI is unavailable inside the provider sandbox`);
    }
    this.toolchainReady = true;
  }

  async run(input: {
    command: "node" | "npm" | "npx";
    args: readonly string[];
    timeoutMs: number;
    capability?: { name: ProviderCapabilityName; value: string };
  }): Promise<ProviderCommandResult> {
    if (input.command === "npx" && !this.toolchainReady) {
      throw new Error("provider CLI command was attempted before the pinned toolchain preflight closed");
    }
    return await this.runInternal(input);
  }

  async runLifecycleProbe(input: {
    capability?: { name: ProviderCapabilityName; value: string };
    label: string;
  }): Promise<boolean> {
    if (!/^[a-z0-9-]+$/.test(input.label)) throw new Error("provider lifecycle probe label is invalid");
    const root = mkdtempSync(join(this.checkout, `.jarvis-provider-lifecycle-${input.label}-`));
    const name = root.slice(this.checkout.length + 1);
    const marker = join(root, "detached-survived");
    const source = join(root, "lifecycle.cjs");
    const secret = input.capability?.value ?? "";
    writeFileSync(source, String.raw`
const { spawn } = require("node:child_process");
const childSource = "const fs=require('node:fs');const p=process.argv[1];setTimeout(()=>fs.writeFileSync(p,'survived'),1200);setInterval(()=>{},1000);";
const child = spawn(process.execPath, ["-e", childSource, process.argv[1]], { detached: true, stdio: "ignore" });
child.unref();
if (process.env.TRIGGER_ACCESS_TOKEN) process.stdout.write(process.env.TRIGGER_ACCESS_TOKEN);
`, { mode: 0o600 });
    try {
      const result = await this.runInternal({
        command: "node",
        args: [`./${name}/lifecycle.cjs`, `./${name}/detached-survived`],
        timeoutMs: 20_000,
        capability: input.capability,
      });
      if (result.code !== 0 || !result.receipt.closeObserved || (secret && result.out.includes(secret))) return false;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_500));
      return !existsSync(marker);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await Promise.allSettled([...this.active]);
    rmSync(this.setup, { force: true });
  }
}

export function providerSandboxRuntimeAvailable(paths: Partial<RuntimePaths> = {}): boolean {
  try {
    runtimePaths(paths);
    return true;
  } catch {
    return false;
  }
}

/** Real staged-worker regression for both capability-free and target-token phases. */
export async function verifyProviderSandboxLifecycle(
  sandbox: ProviderCandidateSandbox,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await sandbox.preflight();
    const noCapability = await sandbox.runLifecycleProbe({ label: "preflight" });
    const capability = await sandbox.runLifecycleProbe({
      label: "capability",
      capability: { name: "TRIGGER_ACCESS_TOKEN", value: `synthetic-target-${randomBytes(16).toString("hex")}` },
    });
    return noCapability && capability
      ? { ok: true }
      : { ok: false, reason: "provider sandbox detached child survived a close barrier" };
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) };
  }
}
