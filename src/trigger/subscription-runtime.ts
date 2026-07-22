import { createRequire } from "node:module";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export type AgentProvider = "codex";

const AUTH_OUTER_KEYS = ["auth_mode", "tokens"] as const;
const AUTH_TOKEN_KEYS = ["access_token", "refresh_token", "id_token", "account_id"] as const;
export const PINNED_CODEX_VERSION = "codex-cli 0.144.5";
export const CHATGPT_LOGIN_STATUS_RECEIPT = "Logged in using ChatGPT";

type ChatgptSubscriptionAuth = {
  auth_mode: "chatgpt";
  tokens: Record<(typeof AUTH_TOKEN_KEYS)[number], string>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

// JSON.parse intentionally accepts duplicate object keys (using the last one),
// which makes a schema check ambiguous. Walk the JSON grammar first so a
// duplicate credential field cannot be smuggled through that behavior.
function rejectDuplicateJsonKeys(input: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(input[index] ?? "")) index++; };
  const fail = (): never => { throw new Error("invalid JSON"); };
  const string = (): string => {
    if (input[index++] !== '"') fail();
    const start = index - 1;
    while (index < input.length) {
      const char = input[index++];
      if (char === '"') return JSON.parse(input.slice(start, index)) as string;
      if (char === "\\") {
        const escape = input[index++];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) fail();
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(index, index + 4))) fail();
          index += 4;
        }
      } else if (char.charCodeAt(0) < 0x20) fail();
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (input[index] === '"') { string(); return; }
    if (input[index] === "{") {
      index++; whitespace();
      const keys = new Set<string>();
      if (input[index] === "}") { index++; return; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate JSON key");
        keys.add(key);
        whitespace();
        if (input[index++] !== ":") fail();
        value(); whitespace();
        if (input[index] === "}") { index++; return; }
        if (input[index++] !== ",") fail();
      }
    }
    if (input[index] === "[") {
      index++; whitespace();
      if (input[index] === "]") { index++; return; }
      while (true) {
        value(); whitespace();
        if (input[index] === "]") { index++; return; }
        if (input[index++] !== ",") fail();
      }
    }
    const start = index;
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index++;
    if (start === index) fail();
    JSON.parse(input.slice(start, index));
  };
  value(); whitespace();
  if (index !== input.length) fail();
}

function apiKeyShaped(value: string): boolean {
  return /^(?:sk|rk|pk|api)[_-]/i.test(value) || /(?:^|[_-])api[_-]?key/i.test(value);
}

function parseChatgptSubscriptionAuthText(json: string): ChatgptSubscriptionAuth {
  rejectDuplicateJsonKeys(json);
  const parsed: unknown = JSON.parse(json);
  if (!isObject(parsed) || !sameKeys(parsed, AUTH_OUTER_KEYS) || parsed.auth_mode !== "chatgpt" || !isObject(parsed.tokens) || !sameKeys(parsed.tokens, AUTH_TOKEN_KEYS)) {
    throw new Error("invalid Codex ChatGPT subscription auth schema");
  }
  const tokens = {} as ChatgptSubscriptionAuth["tokens"];
  for (const key of AUTH_TOKEN_KEYS) {
    const value = parsed.tokens[key];
    if (typeof value !== "string" || !value.trim() || apiKeyShaped(value)) {
      throw new Error("invalid Codex ChatGPT subscription token");
    }
    tokens[key] = value;
  }
  return { auth_mode: "chatgpt", tokens };
}

export function parseChatgptSubscriptionAuth(encoded: string): ChatgptSubscriptionAuth {
  // Accept only standard, padded base64. Buffer otherwise accepts whitespace,
  // URL-safe alphabets, and truncated payloads, none of which are canonical.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("invalid canonical Codex subscription auth encoding");
  }
  const json = Buffer.from(encoded, "base64").toString("utf8");
  if (Buffer.from(json, "utf8").toString("base64") !== encoded) {
    throw new Error("invalid canonical Codex subscription auth encoding");
  }
  return parseChatgptSubscriptionAuthText(json);
}

function canonicalAuthJson(auth: ChatgptSubscriptionAuth): string {
  return JSON.stringify({ auth_mode: auth.auth_mode, tokens: auth.tokens });
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

function authFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): ChatgptSubscriptionAuth {
  // There is deliberately no migration path here. A raw JSON document or
  // bearer token can silently select a different Codex auth mode, so reject it
  // before creating a home directory or starting any child process.
  if (env.CODEX_ACCESS_TOKEN !== undefined || env.CODEX_AUTH_JSON !== undefined) {
    throw new Error("legacy raw Codex credentials are not accepted");
  }
  const encoded = env.CODEX_AUTH_JSON_B64;
  if (!encoded) throw new Error("Codex ChatGPT subscription auth is not configured");
  return parseChatgptSubscriptionAuth(encoded);
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
  let auth: ChatgptSubscriptionAuth;
  try {
    // Validate the sole accepted controller input before touching the
    // filesystem. This is the root boundary for every foreground and durable
    // Codex caller.
    auth = authFromEnvironment(process.env);
  } catch {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: "invalid Codex ChatGPT subscription auth",
    };
  }
  const home = writableCodexHome();
  if (!home) {
    return {
      env: scopedSubscriptionEnv(process.env, provider),
      error: "a writable non-temporary Codex home is unavailable",
    };
  }

  const authPath = join(home, "auth.json");
  writeFileSync(authPath, canonicalAuthJson(auth), { mode: 0o600 });
  chmodSync(authPath, 0o600);

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
  copiedFiles: readonly ("auth.json" | "config.toml" | "AGENTS.md")[] = ["auth.json", "config.toml", "AGENTS.md"],
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
