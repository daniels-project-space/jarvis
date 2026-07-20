import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export type AgentProvider = "codex";

export const CODEX_CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;

export class CodexCredentialRefreshRequiredError extends Error {
  readonly code = "credential_refresh_required";

  constructor() {
    super("Codex subscription credential refresh required before the bounded model segment");
    this.name = "CodexCredentialRefreshRequiredError";
  }
}

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
    "NODE_ENV",
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
    "CODEX_ACCESS_TOKEN",
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

function writableCodexRuntimeRoot(explicitRoot?: string): string | null {
  const candidates = [
    explicitRoot,
    process.env.JARVIS_CODEX_RUNTIME_ROOT,
    process.env.JARVIS_CODEX_HOME ? join(dirname(process.env.JARVIS_CODEX_HOME), ".jarvis-codex-homes") : undefined,
    process.env.HOME && !process.env.HOME.startsWith("/tmp") ? join(process.env.HOME, ".jarvis-codex-homes") : undefined,
    "/home/node/.jarvis-codex-homes",
    "/tmp/work/jarvis-codex-homes",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      /* try the next non-temporary home */
    }
  }
  return null;
}

function jwtExpiryMs(token: string): number | null {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function assertSubscriptionCredentialFresh(
  env: Readonly<Record<string, string | undefined>>,
  boundedRuntimeMs: number,
  nowMs = Date.now(),
): void {
  const token = String(env.CODEX_ACCESS_TOKEN ?? "").trim();
  const expiresAt = token ? jwtExpiryMs(token) : null;
  const requiredUntil = nowMs + Math.max(0, boundedRuntimeMs) + CODEX_CREDENTIAL_REFRESH_MARGIN_MS;
  if (!expiresAt || expiresAt <= requiredUntil) throw new CodexCredentialRefreshRequiredError();
}

function accessTokenFromController(source: NodeJS.ProcessEnv): string {
  const encoded = source.CODEX_AUTH_JSON_B64?.trim();
  if (encoded) {
    if (encoded.length > 2 * 1024 * 1024) throw new Error("invalid Codex subscription auth envelope");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new Error("invalid Codex subscription auth envelope");
    }
    const token = (parsed as { tokens?: { access_token?: unknown } } | null)?.tokens?.access_token;
    if (typeof token !== "string" || !token.trim()) throw new Error("invalid Codex subscription auth envelope");
    return token.trim();
  }
  if (source.CODEX_AUTH_JSON) {
    throw new Error("raw Codex auth JSON is forbidden; refresh the encoded controller credential");
  }
  return String(source.CODEX_ACCESS_TOKEN ?? "").trim();
}

export function prepareSubscriptionEnv(
  provider: AgentProvider,
  options: {
    boundedRuntimeMs?: number;
    nowMs?: number;
    runtimeRoot?: string;
    scope?: string;
    sourceEnv?: NodeJS.ProcessEnv;
  } = {},
): { env: NodeJS.ProcessEnv; error?: string; status?: "credential_refresh_required" } {
  if (provider !== "codex") {
    return { env: {} as NodeJS.ProcessEnv, error: "Jarvis permits only the Codex CLI runtime" };
  }
  const source = options.sourceEnv ?? process.env;
  const root = writableCodexRuntimeRoot(options.runtimeRoot);
  if (!root) {
    return {
      env: scopedSubscriptionEnv(source, provider),
      error: "a writable credentialless Codex runtime root is unavailable",
    };
  }
  let token = "";
  try {
    token = accessTokenFromController(source);
  } catch (error) {
    return {
      env: scopedSubscriptionEnv(source, provider),
      error: error instanceof Error ? error.message : "invalid Codex subscription auth envelope",
    };
  }
  if (!token) return { env: scopedSubscriptionEnv(source, provider), error: "Codex subscription auth is not configured" };

  const safeScope = String(options.scope ?? `controller-${process.pid}-${randomUUID()}`)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80) || "controller";
  const home = mkdtempSync(join(root, `${safeScope}-`));
  // A stale runtime directory must never turn access-token auth back into a
  // refresh-token filesystem credential. The new directory is already empty;
  // this explicit removal protects future changes to its construction.
  rmSync(join(home, "auth.json"), { force: true });

  const env = scopedSubscriptionEnv({
    ...source,
    HOME: dirname(root),
    CODEX_HOME: home,
    CODEX_ACCESS_TOKEN: token,
  }, provider);
  try {
    assertSubscriptionCredentialFresh(env, options.boundedRuntimeMs ?? 0, options.nowMs);
  } catch (error) {
    if (error instanceof CodexCredentialRefreshRequiredError) {
      return { env, error: error.message, status: error.code };
    }
    throw error;
  }

  return { env };
}

export function isolateSubscriptionEnv(
  base: NodeJS.ProcessEnv,
  scope: string,
  root?: string,
): NodeJS.ProcessEnv {
  const sourceHome = String(base.CODEX_HOME ?? "");
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "agent";
  // Codex deliberately refuses to create helper aliases inside a temporary
  // CODEX_HOME. Keep each lease isolated beside the non-temporary source home
  // so its CLI toolchain initializes fully on both GitHub and Trigger workers.
  const isolationRoot = root ?? (sourceHome ? join(dirname(sourceHome), ".jarvis-codex-homes") : "/tmp/work/codex-homes");
  const isolatedHome = join(isolationRoot, safeScope);
  mkdirSync(isolatedHome, { recursive: true });
  // Only Daniel's scoped briefing crosses into a lease home. Authentication
  // remains an in-memory access token on the Codex parent, and strict launcher
  // config replaces user config for every model-driven child.
  rmSync(join(isolatedHome, "auth.json"), { force: true });
  for (const file of ["AGENTS.md"]) {
    const source = join(sourceHome, file);
    if (sourceHome && existsSync(source)) copyFileSync(source, join(isolatedHome, file));
  }
  return { ...base, CODEX_HOME: isolatedHome };
}
