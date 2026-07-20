import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
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

function existingAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${label} must be an existing absolute path`);
  return normalize(realpathSync(path));
}

function assertCredentiallessHome(env: NodeJS.ProcessEnv): void {
  const home = existingAbsolute(String(env.CODEX_HOME ?? ""), "Codex runtime home");
  const authPath = join(home, "auth.json");
  if (existsSync(authPath) || lstatSync(home).isSymbolicLink()) {
    throw new Error("Codex runtime home must not contain a filesystem authentication credential");
  }
}

function assertCapabilityMinimalEnv(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (name === "CODEX_ACCESS_TOKEN") continue;
    if (EXPLICIT_CONTROLLER_CAPABILITY.test(name) || FORBIDDEN_MODEL_CAPABILITY.test(name)) {
      throw new Error(`Codex parent environment contains forbidden controller capability ${name}`);
    }
  }
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY || env.ANTHROPIC_API_KEY) {
    throw new Error("metered model API credentials are forbidden in the Codex parent environment");
  }
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
  assertCapabilityMinimalEnv(input.env);
  assertSubscriptionCredentialFresh(input.env, input.boundedRuntimeMs);
  const token = String(input.env.CODEX_ACCESS_TOKEN ?? "");
  assertControlledArgs(input.mode, input.args, token);

  if (input.mode !== "specialist") {
    return { command, args: [...input.args], cwd, env: { ...input.env } };
  }

  const unshare = existingAbsolute(input.unshareBinary ?? UNSHARE_BINARY, "unshare executable");
  return {
    command: unshare,
    args: [
      "--user",
      "--map-root-user",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--mount-proc=/proc",
      "--propagation",
      "unchanged",
      "--",
      command,
      ...input.args,
    ],
    cwd,
    // This is the complete environment of the unshare process and Codex
    // parent. The trusted Trigger controller's provider capabilities are not
    // inherited; only the expiring subscription access token crosses over.
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
