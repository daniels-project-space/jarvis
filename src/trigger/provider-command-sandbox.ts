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
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PROVIDER_PATH = "/workspace/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTROLLER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const RECEIPT_PROTOCOL = 1;
const RECEIPT_KIND = "jarvis-provider-command-sandbox-preflight";
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_RECEIPT_AGE_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CREDENTIAL_FILE = /(?:^|[._-])(?:auth|credential|token|secret|password)(?:[._-]|$)|(?:\.pem|\.key)$|^(?:\.netrc|\.git-credentials)$/i;
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
const PROXY_URL_KEYS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);
const CAPABILITY_KEYS = ["CONVEX_DEPLOY_KEY", "TRIGGER_ACCESS_TOKEN"] as const;
const REQUIRED_TOOLS = ["node", "npm", "npx", "git", "gh", "curl"] as const;
const consumedReceiptNonces = new Set<string>();

export const PROVIDER_NAMESPACE_FLAGS = Object.freeze([
  "--user",
  "--map-root-user",
  "--mount",
  "--pid",
  "--fork",
  "--kill-child=SIGKILL",
  "--ipc",
  "--uts",
  "--propagation",
  "unchanged",
] as const);

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
  childStarted: () => () => void;
  waitForChildren: () => Promise<void>;
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
    outsideDirectoryFdVisible: boolean;
    workspaceWriteSucceeded: boolean;
    runtimeWriteBlocked: boolean;
    symlinkEscapeBlocked: boolean;
    unrelatedEtcReadable: boolean;
    requiredEtcReadable: boolean;
    devicesUsable: boolean;
    chrootBlocked: boolean;
    mountBlocked: boolean;
    capabilityRegainBlocked: boolean;
    gitMetadataWriteBlocked: boolean;
    gitRefWriteBlocked: boolean;
    gitHookWriteBlocked: boolean;
    gitCommitBlocked: boolean;
    freshHomeAndConfig: boolean;
    ambientSecretsAbsent: boolean;
    runtimeInjectionAbsent: boolean;
  };
  network: { policy: string; namespace: string; expectedNamespace: string };
  tools: Record<string, { available: boolean; version: string }>;
}>;

type EtcRuntimeEntry = Readonly<{
  source: string;
  destination: string;
  kind: "file" | "directory";
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
  devNull: string;
  devZero: string;
  devRandom: string;
  devUrandom: string;
  etc: readonly EtcRuntimeEntry[];
}>;

const FIXED_RUNTIME = Object.freeze({
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
  devNull: "/dev/null",
  devZero: "/dev/zero",
  devRandom: "/dev/random",
  devUrandom: "/dev/urandom",
});

const ETC_RUNTIME_CANDIDATES = Object.freeze([
  ["/etc/resolv.conf", "etc/resolv.conf", "file"],
  ["/etc/hosts", "etc/hosts", "file"],
  ["/etc/nsswitch.conf", "etc/nsswitch.conf", "file"],
  ["/etc/passwd", "etc/passwd", "file"],
  ["/etc/group", "etc/group", "file"],
  ["/etc/ssl", "etc/ssl", "directory"],
  ["/etc/pki", "etc/pki", "directory"],
  ["/etc/ca-certificates", "etc/ca-certificates", "directory"],
] as const);

/**
 * Fixed setup code. Candidate text is never evaluated by this shell: every
 * command and candidate argument remains a positional argv element. The outer
 * user/mount/PID/IPC/UTS namespace builds a narrow chroot with a read-only
 * runtime, a writable checkout, read-only controller-owned Git metadata, and
 * a fresh /proc. The final fixed shell only assembles env -i argv before it
 * execs the already-separated command under drop-all/no_new_privs.
 */
export const PROVIDER_SANDBOX_SETUP = `#!/usr/bin/dash
set -efu
rootfs=$1
workspace=$2
usr_source=$3
bin_source=$4
lib_source=$5
lib64_source=$6
shift 6
dev_null=$1
dev_zero=$2
dev_random=$3
dev_urandom=$4
shift 4
etc_count=$1
shift

readonly_bind() {
  source_path=$1
  destination_path=$2
  /usr/bin/mount --bind "$source_path" "$destination_path"
  /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$destination_path"
}

readonly_device_bind() {
  source_path=$1
  destination_path=$2
  /usr/bin/mount --bind "$source_path" "$destination_path"
  /usr/bin/mount -o remount,bind,ro,nosuid "$destination_path"
}

readonly_bind "$usr_source" "$rootfs/usr"
readonly_bind "$bin_source" "$rootfs/bin"
readonly_bind "$lib_source" "$rootfs/lib"
readonly_bind "$lib64_source" "$rootfs/lib64"

while [ "$etc_count" -gt 0 ]; do
  etc_source=$1
  etc_destination=$2
  shift 2
  readonly_bind "$etc_source" "$rootfs/$etc_destination"
  etc_count=$((etc_count - 1))
done

/usr/bin/mount --bind "$workspace" "$rootfs/workspace"
/usr/bin/mount -o remount,bind,rw,nosuid,nodev "$rootfs/workspace"
/usr/bin/mount --bind "$workspace/.git" "$rootfs/workspace/.git"
/usr/bin/mount -o remount,bind,ro,nosuid,nodev "$rootfs/workspace/.git"
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc "$rootfs/proc"
readonly_device_bind "$dev_null" "$rootfs/dev/null"
readonly_device_bind "$dev_zero" "$rootfs/dev/zero"
readonly_device_bind "$dev_random" "$rootfs/dev/random"
readonly_device_bind "$dev_urandom" "$rootfs/dev/urandom"

cd "$rootfs"
exec /usr/sbin/chroot "$rootfs" \
  /usr/sbin/capsh --drop=all --caps= --inh= --noamb --no-new-privs -- \
  -c 'cd /workspace
    capability_name=\${JARVIS_PROVIDER_CAPABILITY_NAME-none}
    case "$capability_name" in
      none) ;;
      CONVEX_DEPLOY_KEY)
        [ -n "\${CONVEX_DEPLOY_KEY-}" ] || exit 70
        set -- "CONVEX_DEPLOY_KEY=\${CONVEX_DEPLOY_KEY}" "$@"
        ;;
      TRIGGER_ACCESS_TOKEN)
        [ -n "\${TRIGGER_ACCESS_TOKEN-}" ] || exit 70
        set -- "TRIGGER_ACCESS_TOKEN=\${TRIGGER_ACCESS_TOKEN}" "$@"
        ;;
      *) exit 70 ;;
    esac
    if [ -n "\${JARVIS_PROVIDER_PROBE_NONCE-}" ]; then
      set -- \
        "JARVIS_PROVIDER_PROBE_NONCE=\${JARVIS_PROVIDER_PROBE_NONCE}" \
        "JARVIS_PROVIDER_PROBE_RECEIPT=\${JARVIS_PROVIDER_PROBE_RECEIPT-}" \
        "JARVIS_PROVIDER_PROBE_OUTSIDE=\${JARVIS_PROVIDER_PROBE_OUTSIDE-}" \
        "JARVIS_PROVIDER_PROBE_CONTROLLER_PID=\${JARVIS_PROVIDER_PROBE_CONTROLLER_PID-}" \
        "JARVIS_PROVIDER_PROBE_NETWORK_NS=\${JARVIS_PROVIDER_PROBE_NETWORK_NS-}" \
        "$@"
    fi
    exec /usr/bin/env -i \
    PATH="$JARVIS_PROVIDER_PATH" \
    HOME=/home/provider \
    CODEX_HOME=/home/provider/.codex \
    XDG_CONFIG_HOME=/home/provider/.config \
    XDG_CACHE_HOME=/home/provider/.cache \
    TMPDIR=/home/provider/tmp \
    NODE_ENV=development LANG=C.UTF-8 LC_ALL=C.UTF-8 CI=1 TERM=dumb FORCE_COLOR=0 \
    NPM_CONFIG_USERCONFIG=/home/provider/.npmrc \
    NPM_CONFIG_CACHE=/home/provider/.npm-cache \
    NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/home/provider/.gitconfig \
    GIT_CONFIG_COUNT=5 \
    GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
    GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= \
    GIT_CONFIG_KEY_2=core.fsmonitor GIT_CONFIG_VALUE_2=false \
    GIT_CONFIG_KEY_3=core.untrackedCache GIT_CONFIG_VALUE_3=false \
    GIT_CONFIG_KEY_4=safe.directory GIT_CONFIG_VALUE_4=/workspace \
    GIT_TERMINAL_PROMPT=0 GH_PROMPT_DISABLED=1 GH_CONFIG_DIR=/home/provider/.config/gh \
    HTTP_PROXY="\${HTTP_PROXY-}" HTTPS_PROXY="\${HTTPS_PROXY-}" NO_PROXY="\${NO_PROXY-}" \
    http_proxy="\${http_proxy-}" https_proxy="\${https_proxy-}" no_proxy="\${no_proxy-}" \
    "$@"' provider-sandbox "$@"
`;

export const PROVIDER_PREFLIGHT_SOURCE = String.raw`
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
const blockedRead = (target) => { try { fs.readFileSync(target); return false; } catch { return true; } };
const blockedWrite = (target) => { try { fs.writeFileSync(target, "must-not-write"); return false; } catch { return true; } };
const commandBlocked = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", timeout: 3000, ...options }).status !== 0;
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
    if (/(?:VAULT_ACCESS_TOKEN|GITHUB_TOKEN|JARVIS_WORKER_TOKEN|CODEX_ACCESS_TOKEN|CONVEX_DEPLOY_KEY|TRIGGER_ACCESS_TOKEN)=/.test(value.toString("utf8"))) {
      parentEnvironmentAuthorityVisible = true;
    }
  } catch {}
}
try {
  const value = fs.readFileSync("/proc/" + controllerPid + "/environ");
  if (value.length) parentEnvironmentAuthorityVisible = true;
} catch {}
let outsideDirectoryFdVisible = false;
for (let fd = 3; fd < 128; fd += 1) {
  try { if (fs.fstatSync(fd).isDirectory()) outsideDirectoryFdVisible = true; } catch {}
}
let workspaceWriteSucceeded = false;
try {
  const workspaceWritePath = receiptPath.replace(/receipt\.json$/, "workspace-write");
  fs.writeFileSync(workspaceWritePath, "ok");
  workspaceWriteSucceeded = fs.readFileSync(workspaceWritePath, "utf8") === "ok";
  fs.unlinkSync(workspaceWritePath);
} catch {}
let devicesUsable = false;
try {
  fs.writeFileSync("/dev/null", "discarded");
  const randomFd = fs.openSync("/dev/urandom", "r");
  try {
    const randomBytes = Buffer.alloc(16);
    devicesUsable = fs.readSync(randomFd, randomBytes, 0, randomBytes.length, null) === randomBytes.length;
  } finally {
    fs.closeSync(randomFd);
  }
} catch {}
const requiredEtcReadable = ["/etc/resolv.conf", "/etc/hosts", "/etc/passwd", "/etc/group"].every((target) => !blockedRead(target));
const freshHomeAndConfig = process.env.HOME === "/home/provider"
  && process.env.CODEX_HOME === "/home/provider/.codex"
  && process.env.XDG_CONFIG_HOME === "/home/provider/.config"
  && process.env.XDG_CACHE_HOME === "/home/provider/.cache"
  && process.env.NPM_CONFIG_USERCONFIG === "/home/provider/.npmrc"
  && process.env.GIT_CONFIG_GLOBAL === "/home/provider/.gitconfig"
  && fs.readFileSync("/home/provider/.npmrc", "utf8") === ""
  && fs.readFileSync("/home/provider/.gitconfig", "utf8") === "";
const ambientSecretsAbsent = ["VAULT_ACCESS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "CONVEX_DEPLOY_KEY", "TRIGGER_ACCESS_TOKEN"].every((key) => !process.env[key]);
const runtimeInjectionAbsent = !process.env.NODE_OPTIONS && !process.env.NPM_CONFIG_REGISTRY && !process.env.npm_config_registry;
const tools = Object.fromEntries(${JSON.stringify(REQUIRED_TOOLS)}.map((tool) => {
  const result = spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 3000 });
  return [tool, {
    available: result.status === 0,
    version: String(result.stdout || result.stderr || "").trim().replace(/\s+/g, " ").slice(0, 160),
  }];
}));
const networkNamespace = fs.readlinkSync("/proc/self/ns/net");
const gitConfigWriteBlocked = commandBlocked("git", ["config", "--local", "jarvis.sandboxProbe", nonce]);
const gitRefWriteBlocked = commandBlocked("git", ["update-ref", "refs/jarvis-sandbox/" + nonce, "HEAD"]);
const gitHookWriteBlocked = blockedWrite(".git/hooks/jarvis-provider-probe");
const gitCommitBlocked = commandBlocked("git", ["-c", "user.name=JARVIS Probe", "-c", "user.email=probe.invalid", "commit", "--allow-empty", "-m", "sandbox probe"]);
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
    outsideDirectoryFdVisible,
    workspaceWriteSucceeded,
    runtimeWriteBlocked: blockedWrite("/usr/.jarvis-provider-runtime-write"),
    symlinkEscapeBlocked: blockedRead(receiptPath.replace(/receipt\.json$/, "outside-link")),
    unrelatedEtcReadable: !blockedRead("/etc/profile") || !blockedRead("/etc/shadow"),
    requiredEtcReadable,
    devicesUsable,
    chrootBlocked: commandBlocked("/usr/sbin/chroot", ["/", "/bin/true"]),
    mountBlocked: commandBlocked("/usr/bin/mount", ["-t", "tmpfs", "tmpfs", "/home/provider/tmp"]),
    capabilityRegainBlocked: commandBlocked("/usr/sbin/capsh", ["--caps=cap_sys_admin+ep", "--", "-c", "true"]),
    gitMetadataWriteBlocked: blockedWrite(".git/config"),
    gitRefWriteBlocked,
    gitHookWriteBlocked,
    gitCommitBlocked,
    freshHomeAndConfig,
    ambientSecretsAbsent,
    runtimeInjectionAbsent,
  },
  network: {
    policy: "target-egress-allowed-not-secret",
    namespace: networkNamespace,
    expectedNamespace: expectedNetworkNamespace,
  },
  tools,
};
const temporary = receiptPath + ".tmp-" + nonce;
const fd = fs.openSync(temporary, "wx", 0o600);
try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.renameSync(temporary, receiptPath);
const receiptDirectory = fs.openSync(receiptPath.replace(/\/receipt\.json$/, ""), "r");
try { fs.fsyncSync(receiptDirectory); } finally { fs.closeSync(receiptDirectory); }
`;

function pathIsWithin(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

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

function canonicalTrustedSystemPath(
  path: string,
  kind: "file" | "directory" | "device",
  label: string,
): string {
  const canonical = canonicalExisting(path, kind, label);
  const stat = lstatSync(canonical);
  if (stat.uid !== 0) throw new Error(`${label} must be owned by root`);
  if (kind !== "device" && (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable`);
  }
  return canonical;
}

function canonicalOwnedDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const lexical = lstatSync(path);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
  const canonical = realpathSync(path);
  if (resolve(path) !== canonical) throw new Error(`${label} must not traverse a symlinked parent`);
  if (typeof process.getuid === "function" && lexical.uid !== process.getuid()) {
    throw new Error(`${label} must be controller-owned`);
  }
  return canonical;
}

function canonicalCheckout(path: string): string {
  const canonical = canonicalOwnedDirectory(path, "candidate checkout");
  const gitPath = join(canonical, ".git");
  let git;
  try { git = lstatSync(gitPath); } catch { throw new Error("candidate Git metadata directory is missing"); }
  if (git.isSymbolicLink()) throw new Error("candidate Git metadata must not be a symlink");
  if (!git.isDirectory()) {
    throw new Error("candidate .git pointers are forbidden; controller-owned Git metadata must be a directory");
  }
  if (typeof process.getuid === "function" && git.uid !== process.getuid()) {
    throw new Error("candidate Git metadata must be controller-owned");
  }
  return canonical;
}

function validateProxy(name: string, value: string): void {
  if (!value) return;
  if (!PROXY_URL_KEYS.has(name)) {
    if (value.length > 8_192 || /[\0\r\n]/.test(value)) throw new Error(`invalid provider tool proxy exclusion ${name}`);
    return;
  }
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
  const tempRoot = canonicalExisting(tmpdir(), "directory", "system temporary directory");
  const root = canonicalOwnedDirectory(mkdtempSync(join(tempRoot, "jarvis-provider-session-")), "provider tool state");
  const home = join(root, "home");
  const config = join(root, "xdg-config");
  const cache = join(root, "xdg-cache");
  const npmCache = join(root, "npm-cache");
  const temp = join(root, "tmp");
  const codexHome = join(root, "codex-home");
  const ghConfig = join(config, "gh");
  for (const directory of [home, config, cache, npmCache, temp, codexHome, ghConfig]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
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
  Object.assign(env, {
    PATH: CONTROLLER_PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    TMPDIR: temp,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    TERM: "dumb",
    FORCE_COLOR: "0",
    JARVIS_PROVIDER_CAPABILITY_NAME: "none",
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "core.fsmonitor",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.untrackedCache",
    GIT_CONFIG_VALUE_3: "false",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_CONFIG_DIR: ghConfig,
  });
  let activeChildren = 0;
  let cleaned = false;
  const idleWaiters = new Set<() => void>();
  const session: ProviderToolSession = Object.freeze({
    root,
    home,
    env: Object.freeze({ ...env }),
    childStarted: () => {
      if (cleaned) throw new Error("provider tool session is already cleaned");
      activeChildren += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeChildren -= 1;
        if (activeChildren === 0) {
          for (const waiter of idleWaiters) waiter();
          idleWaiters.clear();
        }
      };
    },
    waitForChildren: async () => {
      if (activeChildren === 0) return;
      await new Promise<void>((resolveIdle) => idleWaiters.add(resolveIdle));
    },
    cleanup: () => {
      if (cleaned) return;
      if (activeChildren !== 0) throw new Error("provider tool state cannot be cleaned before every child closes");
      cleaned = true;
      rmSync(root, { recursive: true, force: true });
    },
  });
  return session;
}

/** Return a copy only after revalidating the fresh state. Controller HOME is never retained. */
export function safeProviderToolEnv(base: NodeJS.ProcessEnv, session: ProviderToolSession): NodeJS.ProcessEnv {
  for (const key of PROXY_KEYS) {
    const value = base[key];
    if (value !== undefined) validateProxy(key, value);
  }
  const root = canonicalOwnedDirectory(session.root, "provider tool state");
  const home = canonicalOwnedDirectory(session.home, "provider tool HOME");
  if (!pathIsWithin(home, root)) throw new Error("provider tool HOME escaped its controller-owned state");
  assertSessionTree(root);
  return { ...session.env };
}

function runtimePaths(): RuntimePaths {
  const etc: EtcRuntimeEntry[] = [];
  for (const [source, destination, kind] of ETC_RUNTIME_CANDIDATES) {
    if (!existsSync(source)) continue;
    etc.push({ source: canonicalTrustedSystemPath(source, kind, `provider runtime ${source}`), destination, kind });
  }
  for (const required of ["etc/resolv.conf", "etc/hosts", "etc/passwd", "etc/group"]) {
    if (!etc.some((entry) => entry.destination === required)) throw new Error(`provider runtime ${required} is unavailable`);
  }
  return Object.freeze({
    unshare: canonicalTrustedSystemPath(FIXED_RUNTIME.unshare, "file", "unshare executable"),
    mount: canonicalTrustedSystemPath(FIXED_RUNTIME.mount, "file", "mount executable"),
    chroot: canonicalTrustedSystemPath(FIXED_RUNTIME.chroot, "file", "chroot executable"),
    capsh: canonicalTrustedSystemPath(FIXED_RUNTIME.capsh, "file", "capsh executable"),
    env: canonicalTrustedSystemPath(FIXED_RUNTIME.env, "file", "env executable"),
    shell: canonicalTrustedSystemPath(FIXED_RUNTIME.shell, "file", "namespace setup shell"),
    usr: canonicalTrustedSystemPath(FIXED_RUNTIME.usr, "directory", "runtime /usr"),
    bin: canonicalTrustedSystemPath(FIXED_RUNTIME.bin, "directory", "runtime /bin"),
    lib: canonicalTrustedSystemPath(FIXED_RUNTIME.lib, "directory", "runtime /lib"),
    lib64: canonicalTrustedSystemPath(FIXED_RUNTIME.lib64, "directory", "runtime /lib64"),
    devNull: canonicalTrustedSystemPath(FIXED_RUNTIME.devNull, "device", "runtime /dev/null"),
    devZero: canonicalTrustedSystemPath(FIXED_RUNTIME.devZero, "device", "runtime /dev/zero"),
    devRandom: canonicalTrustedSystemPath(FIXED_RUNTIME.devRandom, "device", "runtime /dev/random"),
    devUrandom: canonicalTrustedSystemPath(FIXED_RUNTIME.devUrandom, "device", "runtime /dev/urandom"),
    etc: Object.freeze(etc),
  });
}

function mkdirRootfs(rootfs: string, etc: readonly EtcRuntimeEntry[]): void {
  for (const directory of [
    "usr", "bin", "lib", "lib64", "etc", "proc", "dev", "workspace",
    "home", "home/provider", "home/provider/.codex", "home/provider/.config",
    "home/provider/.config/gh", "home/provider/.cache", "home/provider/.npm-cache",
    "home/provider/tmp",
  ]) mkdirSync(join(rootfs, directory), { recursive: true, mode: 0o700 });
  for (const file of ["dev/null", "dev/zero", "dev/random", "dev/urandom"]) {
    writeFileSync(join(rootfs, file), "", { mode: 0o600 });
  }
  for (const entry of etc) {
    const destination = join(rootfs, entry.destination);
    if (!pathIsWithin(destination, rootfs)) throw new Error("provider /etc target escaped the rootfs");
    if (entry.kind === "directory") mkdirSync(destination, { recursive: true, mode: 0o700 });
    else {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, "", { mode: 0o600 });
    }
  }
  writeFileSync(join(rootfs, "home/provider/.npmrc"), "", { mode: 0o600 });
  writeFileSync(join(rootfs, "home/provider/.gitconfig"), "", { mode: 0o600 });
}

function toolInsidePath(command: "node" | "npm" | "npx"): string {
  const paths = {
    node: "/usr/local/bin/node",
    npm: "/usr/local/bin/npm",
    npx: "/usr/local/bin/npx",
  } as const;
  const canonical = canonicalTrustedSystemPath(paths[command], "file", `provider ${command} executable`);
  if (!canonical.startsWith("/usr/")) throw new Error(`provider ${command} executable is outside the read-only runtime`);
  return canonical;
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
    HOME: "/home/provider",
    CODEX_HOME: "/home/provider/.codex",
    XDG_CONFIG_HOME: "/home/provider/.config",
    XDG_CACHE_HOME: "/home/provider/.cache",
    TMPDIR: "/home/provider/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    TERM: "dumb",
    FORCE_COLOR: "0",
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
    env.JARVIS_PROVIDER_CAPABILITY_NAME = input.capability.name;
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
  const receiptBytes = Buffer.byteLength(input.raw, "utf8");
  if (receiptBytes < 1) throw new Error("provider sandbox receipt is empty");
  if (receiptBytes > MAX_RECEIPT_BYTES) throw new Error("provider sandbox receipt is oversized");
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
    "outsideDirectoryFdVisible", "workspaceWriteSucceeded", "runtimeWriteBlocked",
    "symlinkEscapeBlocked", "unrelatedEtcReadable", "requiredEtcReadable", "devicesUsable",
    "chrootBlocked", "mountBlocked", "capabilityRegainBlocked", "gitMetadataWriteBlocked",
    "gitRefWriteBlocked", "gitHookWriteBlocked", "gitCommitBlocked", "freshHomeAndConfig",
    "ambientSecretsAbsent", "runtimeInjectionAbsent",
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
    || parsed.authority.outsideDirectoryFdVisible
    || parsed.authority.unrelatedEtcReadable
    || !parsed.authority.outsideWriteBlocked
    || !parsed.authority.workspaceWriteSucceeded
    || !parsed.authority.runtimeWriteBlocked
    || !parsed.authority.symlinkEscapeBlocked
    || !parsed.authority.requiredEtcReadable
    || !parsed.authority.devicesUsable
    || !parsed.authority.chrootBlocked
    || !parsed.authority.mountBlocked
    || !parsed.authority.capabilityRegainBlocked
    || !parsed.authority.gitMetadataWriteBlocked
    || !parsed.authority.gitRefWriteBlocked
    || !parsed.authority.gitHookWriteBlocked
    || !parsed.authority.gitCommitBlocked
    || !parsed.authority.freshHomeAndConfig
    || !parsed.authority.ambientSecretsAbsent
    || !parsed.authority.runtimeInjectionAbsent
  ) throw new Error("provider sandbox authority boundary failed");
  if (
    !isRecord(parsed.network)
    || !exactObjectKeys(parsed.network, ["policy", "namespace", "expectedNamespace"])
    || parsed.network.policy !== "target-egress-allowed-not-secret"
    || typeof parsed.network.namespace !== "string"
    || parsed.network.namespace !== parsed.network.expectedNamespace
    || !/^net:\[\d+\]$/.test(parsed.network.namespace)
  ) throw new Error("provider sandbox network policy receipt is invalid");
  if (!isRecord(parsed.tools) || !exactObjectKeys(parsed.tools, REQUIRED_TOOLS)) {
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

export function readProviderSandboxReceipt(path: string): string {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error("provider sandbox receipt is missing"); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("provider sandbox receipt is not a unique regular file");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("provider sandbox receipt has the wrong owner");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("provider sandbox receipt permissions are too broad");
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
  }) {
    this.checkout = canonicalCheckout(input.checkout);
    const sessionRoot = canonicalOwnedDirectory(input.session.root, "provider tool state");
    if (pathIsWithin(sessionRoot, this.checkout) || pathIsWithin(this.checkout, sessionRoot)) {
      throw new Error("provider sandbox state and candidate checkout must be disjoint");
    }
    this.setup = join(sessionRoot, "provider-sandbox-setup");
    writeFileSync(this.setup, PROVIDER_SANDBOX_SETUP, { mode: 0o500 });
    chmodSync(this.setup, 0o500);
    canonicalExisting(this.setup, "file", "provider sandbox setup");
  }

  private getPaths(): RuntimePaths {
    if (!this.paths) {
      const paths = runtimePaths();
      for (const [label, path] of [
        ["runtime /usr", paths.usr],
        ["runtime /bin", paths.bin],
        ["runtime /lib", paths.lib],
        ["runtime /lib64", paths.lib64],
      ] as const) {
        if (pathIsWithin(path, this.checkout)) throw new Error(`${label} must be outside the candidate-writable checkout`);
      }
      this.paths = paths;
    }
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
    let releaseSessionChild: (() => void) | undefined;
    try {
      safeProviderToolEnv(this.input.baseEnv, this.input.session);
      const paths = this.getPaths();
      rootfs = canonicalOwnedDirectory(
        mkdtempSync(join(this.input.session.root, "rootfs-")),
        "provider sandbox rootfs",
      );
      if (pathIsWithin(rootfs, this.checkout) || pathIsWithin(this.checkout, rootfs)) {
        throw new Error("provider sandbox rootfs and candidate checkout must be disjoint");
      }
      mkdirRootfs(rootfs, paths.etc);
      const insideCommand = toolInsidePath(input.command);
      const env = strictCandidateEnv({ base: this.input.baseEnv, capability: input.capability, probe: input.probe });
      const etcArgs = paths.etc.flatMap((entry) => [entry.source, entry.destination]);
      const invocationArgs = [
        ...PROVIDER_NAMESPACE_FLAGS, "--", this.setup,
        rootfs, this.checkout, paths.usr, paths.bin, paths.lib, paths.lib64,
        paths.devNull, paths.devZero, paths.devRandom, paths.devUrandom,
        String(paths.etc.length), ...etcArgs, insideCommand, ...args,
      ];
      const commandDigest = createHash("sha256")
        .update(paths.unshare).update("\0").update(invocationArgs.join("\0"))
        .digest("hex");
      const startedAt = Date.now();
      releaseSessionChild = this.input.session.childStarted();
      const child = spawn(paths.unshare, invocationArgs, {
        cwd: this.input.session.root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const secrets = input.capability ? [input.capability.value] : [];
      const promise = new Promise<ProviderCommandResult>((resolveResult) => {
        let output = "";
        let processError: Error | undefined;
        let timedOut = false;
        const append = (chunk: unknown) => { output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES); };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", (error) => { processError = error; });
        const timer = setTimeout(() => {
          timedOut = true;
          if (process.platform !== "win32" && child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* namespace group already closed */ }
          }
          try { child.kill("SIGKILL"); } catch { /* CLOSE remains the barrier */ }
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
        releaseSessionChild?.();
      });
      this.active.add(promise);
      void promise.then(
        () => this.active.delete(promise),
        () => this.active.delete(promise),
      );
      return promise;
    } catch (error) {
      if (rootfs) rmSync(rootfs, { recursive: true, force: true });
      releaseSessionChild?.();
      return Promise.reject(error);
    }
  }

  async preflight(): Promise<ProviderSandboxObservation> {
    if (this.preflightObservation) return this.preflightObservation;
    const probe = mkdtempSync(join(this.checkout, ".jarvis-provider-probe-"));
    const probeName = probe.slice(this.checkout.length + 1);
    const receipt = join(probe, "receipt.json");
    const outsideRoot = canonicalOwnedDirectory(
      mkdtempSync(join(canonicalExisting(tmpdir(), "directory", "system temporary directory"), "jarvis-provider-outside-")),
      "synthetic controller credential state",
    );
    if (pathIsWithin(outsideRoot, this.checkout) || pathIsWithin(this.checkout, outsideRoot)) {
      throw new Error("synthetic controller credential and candidate checkout must be disjoint");
    }
    const outside = join(outsideRoot, "controller-credential.txt");
    const nonce = randomBytes(32).toString("hex");
    const source = join(probe, "preflight.cjs");
    writeFileSync(outside, `jarvis-synthetic-controller-credential-${nonce}`, { mode: 0o600 });
    writeFileSync(source, PROVIDER_PREFLIGHT_SOURCE, { mode: 0o600 });
    symlinkSync(outside, join(probe, "outside-link"));
    const expectedNetworkNamespace = readlinkSync("/proc/self/ns/net");
    try {
      const startedAt = Date.now();
      const result = await this.runInternal({
        command: "node",
        args: [`./${probeName}/preflight.cjs`],
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
      if (result.code !== 0 || !result.receipt.closeObserved) {
        throw new Error(`provider sandbox preflight failed: ${result.out.trim().slice(-500) || `exit ${String(result.code)}`}`);
      }
      this.preflightObservation = validateProviderSandboxReceipt({
        raw: readProviderSandboxReceipt(receipt),
        nonce,
        startedAt,
        closedAt: result.receipt.closedAt,
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
    if (input.command === "npm" && input.args[0] === "ci" && !input.args.includes("--ignore-scripts")) {
      throw new Error("provider npm ci must include --ignore-scripts");
    }
    if (input.command === "npx" && !this.toolchainReady) {
      throw new Error("provider CLI command was attempted before the pinned toolchain preflight closed");
    }
    return await this.runInternal(input);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.active]);
    await this.input.session.waitForChildren();
  }

  async runLifecycleProbe(input: {
    capability?: { name: ProviderCapabilityName; value: string };
    forcedTimeout: boolean;
    label: string;
  }): Promise<Readonly<{ descendantReaped: boolean; closeObserved: boolean; timedOut: boolean; secretRedacted: boolean }>> {
    if (!/^[a-z0-9-]+$/.test(input.label)) throw new Error("provider lifecycle probe label is invalid");
    const root = mkdtempSync(join(this.checkout, `.jarvis-provider-lifecycle-${input.label}-`));
    const name = root.slice(this.checkout.length + 1);
    const marker = join(root, "detached-survived");
    const source = join(root, "lifecycle.cjs");
    const secret = input.capability?.value ?? "";
    writeFileSync(source, String.raw`
const { spawn } = require("node:child_process");
const childSource = "const fs=require('node:fs');const p=process.argv[1];setTimeout(()=>fs.writeFileSync(p,'survived'),900);setInterval(()=>{},1000);";
const child = spawn(process.execPath, ["-e", childSource, process.argv[1]], { detached: true, stdio: "ignore" });
child.unref();
if (process.env.TRIGGER_ACCESS_TOKEN) process.stdout.write(process.env.TRIGGER_ACCESS_TOKEN);
if (process.env.CONVEX_DEPLOY_KEY) process.stdout.write(process.env.CONVEX_DEPLOY_KEY);
if (process.argv[2] === "timeout") setInterval(() => {}, 1000);
`, { mode: 0o600 });
    try {
      const result = await this.runInternal({
        command: "node",
        args: [`./${name}/lifecycle.cjs`, `./${name}/detached-survived`, input.forcedTimeout ? "timeout" : "natural"],
        timeoutMs: input.forcedTimeout ? 250 : 20_000,
        capability: input.capability,
      });
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_100));
      const secretRedacted = !secret || (!result.out.includes(secret) && result.out.includes("[REDACTED]"));
      return Object.freeze({
        descendantReaped: !existsSync(marker),
        closeObserved: result.receipt.closeObserved,
        timedOut: result.receipt.timedOut,
        secretRedacted,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.waitForIdle();
    rmSync(this.setup, { force: true });
  }
}

export function providerSandboxRuntimeAvailable(): boolean {
  try {
    runtimePaths();
    return true;
  } catch {
    return false;
  }
}

/** Real staged-worker regression for capability-free and target-token phases. */
export async function verifyProviderSandboxLifecycle(
  sandbox: ProviderCandidateSandbox,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await sandbox.preflight();
    const phases = [
      { label: "natural-preflight", forcedTimeout: false },
      { label: "timeout-preflight", forcedTimeout: true },
      {
        label: "natural-capability",
        forcedTimeout: false,
        capability: { name: "TRIGGER_ACCESS_TOKEN" as const, value: `synthetic-target-${randomBytes(16).toString("hex")}` },
      },
      {
        label: "timeout-capability",
        forcedTimeout: true,
        capability: { name: "TRIGGER_ACCESS_TOKEN" as const, value: `synthetic-target-${randomBytes(16).toString("hex")}` },
      },
    ];
    for (const phase of phases) {
      const observation = await sandbox.runLifecycleProbe(phase);
      if (
        !observation.closeObserved
        || !observation.descendantReaped
        || !observation.secretRedacted
        || observation.timedOut !== phase.forcedTimeout
      ) return { ok: false, reason: `provider sandbox lifecycle failed during ${phase.label}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error instanceof Error ? error.message : error) };
  }
}
