import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  canonicalAuthJson,
  parseChatgptSubscriptionAuthText,
} from "./subscription-auth";
import {
  SubscriptionSessionError,
  subscriptionOperatorSignal,
  type AcquiredSubscriptionSession,
  type ManagedSubscriptionSessionController,
} from "./subscription-session";
import { productionSubscriptionSessionController } from "./subscription-session-r2";

export { parseChatgptSubscriptionAuth } from "./subscription-auth";

export type AgentProvider = "codex";

export const PINNED_CODEX_VERSION = "codex-cli 0.144.5";
export const CHATGPT_LOGIN_STATUS_RECEIPT = "Logged in using ChatGPT";

const nodeRequire = createRequire(import.meta.url);

export const REQUIRED_AGENT_TOOLS = ["curl", "git", "node", "npm", "npx", "gh"] as const;

export function missingSubscriptionTools(
  env: Readonly<Record<string, string | undefined>>,
  tools: readonly string[] = REQUIRED_AGENT_TOOLS,
): string[] {
  const directories = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  return tools.filter((tool) =>
    !directories.some((directory) => {
      try {
        accessSync(join(directory, tool), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

export function resolveSubscriptionAgentBin(provider: AgentProvider): string | null {
  if (provider !== "codex") return null;
  try {
    const packageName = "@openai/codex";
    const command = "codex";
    const pkgJson = nodeRequire.resolve(`${packageName}/package.json`);
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", command)];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        bin?: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[command];
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
      /* package metadata fallback above remains valid */
    }
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
}

function scopedSubscriptionEnv(
  source: NodeJS.ProcessEnv,
  provider: AgentProvider,
): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "NODE_PATH",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "TERM",
    "CI",
    "SHELL",
    "USER",
    "LOGNAME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "JARVIS_AGENT_PROVIDER",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const key of allow) if (source[key] !== undefined) env[key] = source[key];
  env.PATH = source.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  env.JARVIS_AGENT_PROVIDER = provider;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  // Never let a subscription-backed subprocess silently switch to metered API
  // billing, and never pass unrelated application/provider secrets to it.
  env.ANTHROPIC_API_KEY = "";
  env.OPENAI_API_KEY = "";
  env.CODEX_API_KEY = "";
  return env;
}

type SessionAcquirer = Pick<ManagedSubscriptionSessionController, "acquire">;

export type PreparedSubscriptionEnv = {
  env: NodeJS.ProcessEnv;
  snapshotVersion?: number;
  snapshotExpiresAt?: number;
  snapshotFence?: number;
  error?: string;
};

export async function prepareSubscriptionEnv(
  provider: AgentProvider,
  options: {
    controller?: SessionAcquirer;
    root?: string;
    scope?: string;
    minimumValidityMs?: number;
    afterUnauthorizedVersion?: number;
  } = {},
): Promise<PreparedSubscriptionEnv> {
  if (provider !== "codex") {
    return { env: {} as NodeJS.ProcessEnv, error: "Jarvis permits only the Codex CLI runtime" };
  }
  if (process.env.CODEX_AUTH_JSON_B64 !== undefined
    || process.env.CODEX_AUTH_JSON !== undefined
    || process.env.CODEX_ACCESS_TOKEN !== undefined) {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: subscriptionOperatorSignal(new SubscriptionSessionError("configuration_missing")),
    };
  }
  let snapshot: AcquiredSubscriptionSession;
  try {
    const bin = resolveSubscriptionAgentBin(provider);
    if (!bin) return { env: scopedSubscriptionEnv(process.env, provider), error: "codex binary not found" };
    const controller = options.controller ?? await productionSubscriptionSessionController(bin);
    snapshot = await controller.acquire({
      minimumValidityMs: options.minimumValidityMs,
      afterUnauthorizedVersion: options.afterUnauthorizedVersion,
    });
  } catch (error) {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: subscriptionOperatorSignal(error),
    };
  }

  try {
    const root = options.root ?? "/home/node/.jarvis-codex-consumers";
    if (root.startsWith("/tmp/work") || root === process.cwd()) throw new Error("unsafe consumer root");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const safeScope = (options.scope ?? "runtime").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "runtime";
    const home = mkdtempSync(join(root, `${safeScope}-`));
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, canonicalAuthJson(snapshot.auth), { mode: 0o600 });
    chmodSync(authPath, 0o600);
    return {
      env: scopedSubscriptionEnv(
        { ...process.env, HOME: dirname(home), CODEX_HOME: home },
        provider,
      ),
      snapshotVersion: snapshot.version,
      snapshotExpiresAt: snapshot.expiresAt,
      snapshotFence: snapshot.fence,
    };
  } catch {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: "Codex subscription consumer home is unavailable",
    };
  }
}

export function isolateSubscriptionEnv(
  base: NodeJS.ProcessEnv,
  scope: string,
  root?: string,
  copiedFiles: readonly ("auth.json" | "config.toml" | "AGENTS.md")[] = ["auth.json", "config.toml", "AGENTS.md"],
): NodeJS.ProcessEnv {
  const sourceHome = String(base.CODEX_HOME ?? "");
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "agent";
  // Codex deliberately refuses to create helper aliases inside a temporary
  // CODEX_HOME. Keep each lease isolated beside the non-temporary source home
  // so its CLI toolchain initializes fully on both GitHub and Trigger workers.
  const isolationRoot = root ?? (sourceHome ? join(dirname(sourceHome), ".jarvis-codex-homes") : "/tmp/work/codex-homes");
  const isolatedHome = join(isolationRoot, `${safeScope}-${randomUUID()}`);
  mkdirSync(isolatedHome, { recursive: true });
  // Authentication and Daniel's scoped briefing are read-only inputs. System
  // skills are intentionally not copied: every concurrent Codex process gets
  // its own install directory, removing the shared `skills/` startup race.
  for (const file of copiedFiles) {
    const source = join(sourceHome, file);
    if (!sourceHome || !existsSync(source)) continue;
    if (file === "auth.json") {
      // The source home is populated only by prepareSubscriptionEnv. Validate
      // again at this process boundary so an arbitrary pre-existing auth.json
      // can never be copied into a specialist home.
      const auth = parseChatgptSubscriptionAuthText(readFileSync(source, "utf8"));
      writeFileSync(join(isolatedHome, file), canonicalAuthJson(auth), { mode: 0o600 });
    } else {
      copyFileSync(source, join(isolatedHome, file));
    }
  }
  const authPath = join(isolatedHome, "auth.json");
  if (existsSync(authPath)) chmodSync(authPath, 0o600);
  // This is the final boundary before spawn(). Do not re-expand the
  // controller environment: it carries receipt, vault, Convex, Trigger and
  // GitHub authority that a Codex specialist must never inherit.
  return scopedSubscriptionEnv({ ...base, CODEX_HOME: isolatedHome }, "codex");
}

/** Delete the access snapshot once the trusted Codex parent has loaded it. */
export function consumeSubscriptionAuth(env: Readonly<NodeJS.ProcessEnv>): void {
  const home = String(env.CODEX_HOME ?? "");
  if (!home) return;
  const authPath = join(home, "auth.json");
  if (!existsSync(authPath)) return;
  // Validate before deletion so this helper cannot be redirected at an
  // arbitrary file through a malformed home prepared outside this module.
  parseChatgptSubscriptionAuthText(readFileSync(authPath, "utf8"));
  unlinkSync(authPath);
}

export function isCodexUnauthorizedError(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error ?? "");
  return /(?:\b401\b|unauthori[sz]ed|authentication (?:failed|required)|refresh[_ -]?token[_ -]?reused|login required)/i.test(value);
}

export function isolateCloudSubscriptionEnv(
  base: NodeJS.ProcessEnv,
  scope: string,
  root?: string,
): NodeJS.ProcessEnv {
  // Cloud threads receive their entire executable policy through thread/start.
  // Copy only subscription auth so user config cannot inject a legacy sandbox,
  // MCP server, plugin, hook, rule, or instruction source into the specialist.
  return isolateSubscriptionEnv(base, scope, root, ["auth.json"]);
}

export type CodexPreflightReceipt = {
  version: typeof PINNED_CODEX_VERSION;
  loginStatus: typeof CHATGPT_LOGIN_STATUS_RECEIPT;
};

type CodexPreflightSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; encoding: "utf8"; stdio: "pipe"; timeout: number },
) => Pick<SpawnSyncReturns<string>, "status" | "error" | "stdout" | "stderr">;

function commandReceipt(result: Pick<SpawnSyncReturns<string>, "status" | "error" | "stdout" | "stderr">): string | null {
  if (result.error || result.status !== 0) return null;
  // The CLI has emitted status receipts on either stream across releases.
  // Require the exact expected text after combining both, rather than trusting
  // stdout while an authentication error is present on stderr.
  return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.trim();
}

export function verifyCodexSubscriptionPreflight(
  bin: string,
  env: NodeJS.ProcessEnv,
  run: CodexPreflightSpawn = spawnSync,
): { receipt?: CodexPreflightReceipt; error?: string } {
  const options = { env, encoding: "utf8" as const, stdio: "pipe" as const, timeout: 10_000 };
  const version = commandReceipt(run(bin, ["--version"], options));
  if (version !== PINNED_CODEX_VERSION) return { error: "pinned Codex version receipt failed" };
  const loginStatus = commandReceipt(run(bin, ["login", "status"], options));
  if (loginStatus !== CHATGPT_LOGIN_STATUS_RECEIPT) return { error: "Codex ChatGPT login-status receipt failed" };
  return { receipt: { version: PINNED_CODEX_VERSION, loginStatus: CHATGPT_LOGIN_STATUS_RECEIPT } };
}
