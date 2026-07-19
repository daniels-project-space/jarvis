import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export type AgentProvider = "codex";

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

function writableCodexHome(): string | null {
  const candidates = [
    process.env.JARVIS_CODEX_HOME,
    process.env.HOME && !process.env.HOME.startsWith("/tmp") ? join(process.env.HOME, ".codex") : undefined,
    "/home/node/.codex",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    if (candidate.startsWith("/tmp")) continue;
    try {
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      /* try the next non-temporary home */
    }
  }
  return null;
}

export function prepareSubscriptionEnv(
  provider: AgentProvider,
): { env: NodeJS.ProcessEnv; error?: string } {
  if (provider !== "codex") {
    return { env: {} as NodeJS.ProcessEnv, error: "Jarvis permits only the Codex CLI runtime" };
  }
  const home = writableCodexHome();
  if (!home) {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: "a writable non-temporary Codex home is unavailable",
    };
  }

  const encoded = process.env.CODEX_AUTH_JSON_B64;
  const raw = process.env.CODEX_AUTH_JSON;
  if (encoded || raw) {
    try {
      const json = encoded ? Buffer.from(encoded, "base64").toString("utf8") : raw!;
      JSON.parse(json);
      const authPath = join(home, "auth.json");
      writeFileSync(authPath, json, { mode: 0o600 });
      chmodSync(authPath, 0o600);
    } catch {
      return {
        env: scopedSubscriptionEnv(process.env, provider),
        error: "invalid Codex subscription auth",
      };
    }
  }
  if (!process.env.CODEX_ACCESS_TOKEN && !encoded && !raw) {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: "Codex subscription auth is not configured",
    };
  }

  return {
    env: scopedSubscriptionEnv(
      {
        ...process.env,
        HOME: process.env.HOME && !process.env.HOME.startsWith("/tmp") ? process.env.HOME : dirname(home),
        CODEX_HOME: home,
      },
      provider,
    ),
  };
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
  // Authentication and Daniel's scoped briefing are read-only inputs. System
  // skills are intentionally not copied: every concurrent Codex process gets
  // its own install directory, removing the shared `skills/` startup race.
  for (const file of ["auth.json", "config.toml", "AGENTS.md"]) {
    const source = join(sourceHome, file);
    if (sourceHome && existsSync(source)) copyFileSync(source, join(isolatedHome, file));
  }
  const authPath = join(isolatedHome, "auth.json");
  if (existsSync(authPath)) chmodSync(authPath, 0o600);
  return { ...base, CODEX_HOME: isolatedHome };
}
