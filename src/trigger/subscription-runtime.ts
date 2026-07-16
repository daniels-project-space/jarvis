import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AgentProvider = "codex" | "claude";

const nodeRequire = createRequire(import.meta.url);

export function resolveSubscriptionAgentBin(provider: AgentProvider): string | null {
  try {
    const packageName = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    const command = provider === "codex" ? "codex" : "claude";
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

function scopedSubscriptionEnv(source: NodeJS.ProcessEnv, provider: AgentProvider): NodeJS.ProcessEnv {
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
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_ACCESS_TOKEN",
    "JARVIS_AGENT_PROVIDER",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const key of allow) if (source[key] !== undefined) env[key] = source[key];
  env.JARVIS_AGENT_PROVIDER = provider;
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
  if (provider === "claude") {
    const home = process.env.JARVIS_CLAUDE_HOME ?? "/tmp/claude-home";
    mkdirSync(join(home, ".claude"), { recursive: true });
    return {
      env: scopedSubscriptionEnv({ ...process.env, HOME: home }, provider),
    };
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
