import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { assertSubscriptionCredentialFresh } from "./subscription-runtime";

export type CodexChildMode = "specialist" | "restricted" | "foreground";

export type CodexLaunchInput = {
  mode: CodexChildMode;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  boundedRuntimeMs: number;
  unshareBinary?: string;
};

export type CodexInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

const UNSHARE_BINARY = "/usr/bin/unshare";
const NAMESPACE_SHELL = "/bin/sh";
export const PRIVATE_PROC_NAMESPACE_SETUP = 'mount -t proc proc /proc && exec "$@"';
const FORBIDDEN_MODEL_CAPABILITY = /(?:^|_)(?:AUTH_JSON|API_KEY|ACCESS_KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PRIVATE_KEY)(?:_|$)/i;
const EXPLICIT_CONTROLLER_CAPABILITY = /^(?:GITHUB_TOKEN|GH_TOKEN|VAULT_ACCESS_TOKEN|JARVIS_(?:WORKER|DISPATCH)_TOKEN|VERCEL_TOKEN(?:_|$)|CONVEX_DEPLOY_KEY(?:_|$)|TRIGGER_(?:ACCESS_TOKEN|SECRET_KEY)(?:_|$)|CLOUDFLARE_API_TOKEN(?:_|$)|R2_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)(?:_|$)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)(?:_|$))/i;
const MODEL_ONLY_DISABLED = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "computer_use",
  "multi_agent",
] as const;

const CODEX_PARENT_ENV = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "CODEX_ACCESS_TOKEN",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "CI",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
]);
const PROXY_URL_KEYS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);
const FORBIDDEN_CODEX_HOME_ENTRY = /(?:^|[._-])(?:auth|credential|token|secret|password)(?:[._-]|$)|(?:\.pem|\.key)$|^(?:\.netrc|\.git-credentials|\.npmrc)$/i;

function existingAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an existing absolute path`);
  try {
    lstatSync(path);
    return normalize(realpathSync(path));
  } catch {
    throw new Error(`${label} must be an existing absolute path`);
  }
}

function assertCredentiallessHome(env: NodeJS.ProcessEnv): void {
  const originalHome = normalize(String(env.CODEX_HOME ?? ""));
  if (!isAbsolute(originalHome)) throw new Error("Codex runtime home must be an existing absolute path");
  let homeStat;
  try {
    // This must happen before realpath: realpath erases the evidence that the
    // controller handed the launcher a symlink in the first place.
    homeStat = lstatSync(originalHome);
  } catch {
    throw new Error("Codex runtime home must be an existing absolute path");
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error("Codex runtime home must be a non-symlink directory");
  }
  const home = normalize(realpathSync(originalHome));
  const authPath = join(home, "auth.json");
  try {
    lstatSync(authPath);
    throw new Error("Codex runtime home must not contain a filesystem authentication credential");
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not contain")) throw error;
  }

  const pending = [{ directory: home, depth: 0 }];
  let inspected = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      inspected += 1;
      if (inspected > 2_000) throw new Error("Codex runtime home exceeds the credential inspection boundary");
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error("Codex runtime home must not contain symlinked filesystem material");
      }
      if (FORBIDDEN_CODEX_HOME_ENTRY.test(entry.name)) {
        throw new Error("Codex runtime home contains unexpected filesystem credential material");
      }
      if (stat.isDirectory() && depth < 3) pending.push({ directory: path, depth: depth + 1 });
    }
  }
}

function safeProxyUrl(name: string, value: string): void {
  if (!PROXY_URL_KEYS.has(name)) return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Codex parent environment contains invalid proxy URL ${name}`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`Codex parent environment contains credential-bearing or non-canonical proxy URL ${name}`);
  }
}

function capabilityMinimalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const minimal = {} as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (name !== "CODEX_ACCESS_TOKEN" && (EXPLICIT_CONTROLLER_CAPABILITY.test(name) || FORBIDDEN_MODEL_CAPABILITY.test(name))) {
      throw new Error(`Codex parent environment contains forbidden controller capability ${name}`);
    }
    if (name === "NODE_OPTIONS" || /^(?:NPM_CONFIG_REGISTRY|npm_config_registry)$/.test(name)) {
      throw new Error(`Codex parent environment contains forbidden runtime injection variable ${name}`);
    }
    safeProxyUrl(name, value);
    if (CODEX_PARENT_ENV.has(name)) minimal[name] = value;
  }
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY || env.ANTHROPIC_API_KEY) {
    throw new Error("metered model API credentials are forbidden in the Codex parent environment");
  }
  minimal.PATH = String(minimal.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  minimal.HOME = String(minimal.CODEX_HOME ?? minimal.HOME ?? "");
  minimal.OPENAI_API_KEY = "";
  minimal.CODEX_API_KEY = "";
  minimal.ANTHROPIC_API_KEY = "";
  return minimal;
}

function hasDisabledFeature(args: readonly string[], feature: string): boolean {
  return args.some((arg, index) => arg === feature && args[index - 1] === "--disable");
}

function assertControlledArgs(mode: CodexChildMode, args: readonly string[], token: string): void {
  const joined = args.join("\0");
  if (token && joined.includes(token)) throw new Error("Codex access token must never be placed in argv");
  if (args.includes("--dangerously-bypass-approvals-and-sandbox") || args.includes("danger-full-access")) {
    throw new Error("danger-full-access is forbidden for every model-driven child");
  }
  if (!joined.includes('approval_policy="never"') || !joined.includes('shell_environment_policy.inherit="none"')) {
    throw new Error("Codex child is missing strict approval or shell-environment policy");
  }
  if (mode === "specialist") {
    if (
      !args.includes("exec")
      || !args.includes("workspace-write")
      || !joined.includes("features.use_legacy_landlock=true")
      || !joined.includes("sandbox_workspace_write.network_access=false")
      || hasDisabledFeature(args, "shell_tool")
      || hasDisabledFeature(args, "unified_exec")
    ) {
      throw new Error("specialist Codex child is missing the classic legacy-Landlock workspace policy");
    }
    return;
  }
  for (const feature of MODEL_ONLY_DISABLED) {
    if (!hasDisabledFeature(args, feature)) throw new Error(`model-only Codex child did not disable ${feature}`);
  }
  if (mode === "foreground" && args[0] !== "app-server") {
    throw new Error("foreground Codex child must use the controlled app-server path");
  }
  if (mode === "restricted" && !args.includes("read-only")) {
    throw new Error("restricted Codex child must use read-only mode");
  }
}

/**
 * The sole process-construction boundary for every model-driven Codex child.
 * Specialists add a fresh user/PID namespace and `/proc` mount before Codex;
 * reasoning-only children receive no command tools at all.
 */
export function buildCodexInvocation(input: CodexLaunchInput): CodexInvocation {
  const command = existingAbsolute(input.command, "Codex executable");
  const cwd = existingAbsolute(input.cwd, "Codex working directory");
  assertCredentiallessHome(input.env);
  const env = capabilityMinimalEnv(input.env);
  assertSubscriptionCredentialFresh(input.env, input.boundedRuntimeMs);
  const token = String(input.env.CODEX_ACCESS_TOKEN ?? "");
  assertControlledArgs(input.mode, input.args, token);

  if (input.mode !== "specialist") {
    return { command, args: [...input.args], cwd, env };
  }

  return buildPrivateProcNamespaceInvocation({
    command,
    args: input.args,
    cwd,
    env,
    unshareBinary: input.unshareBinary,
  });
}

/**
 * One argv-safe namespace recipe shared by the launcher, preflight, deployed
 * smoke, and lifecycle tests. Only this fixed string is interpreted by a
 * shell; the executable, prompt, and credentials remain separate argv/env.
 */
export function buildPrivateProcNamespaceInvocation(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  unshareBinary?: string;
}): CodexInvocation {
  const unshare = existingAbsolute(input.unshareBinary ?? UNSHARE_BINARY, "unshare executable");
  const command = existingAbsolute(input.command, "namespace child executable");
  const cwd = existingAbsolute(input.cwd, "namespace working directory");
  const shell = existingAbsolute(NAMESPACE_SHELL, "namespace setup shell");
  return {
    command: unshare,
    args: [
      "--user",
      "--map-root-user",
      "--mount",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--propagation",
      "unchanged",
      "--",
      shell,
      "-c",
      PRIVATE_PROC_NAMESPACE_SETUP,
      "sh",
      command,
      ...input.args.map(String),
    ],
    cwd,
    env: { ...input.env },
  };
}

export function spawnCodex(
  input: CodexLaunchInput,
  options: Omit<SpawnOptions, "cwd" | "env"> = {},
): ChildProcessWithoutNullStreams {
  const invocation = buildCodexInvocation(input);
  return spawn(invocation.command, invocation.args, {
    ...options,
    cwd: invocation.cwd,
    env: invocation.env,
  }) as ChildProcessWithoutNullStreams;
}
