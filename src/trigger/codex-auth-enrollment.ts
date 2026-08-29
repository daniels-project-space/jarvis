import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { metadata, task } from "@trigger.dev/sdk/v3";
import { parseChatgptSubscriptionAuthText } from "./subscription-auth";
import { productionSubscriptionSessionController } from "./subscription-session-r2";

export const CODEX_DEVICE_AUTH_URI = "https://auth.openai.com/codex/device";
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const LOGIN_TIMEOUT_MS = 16 * 60_000;
const LOGIN_OUTPUT_MAX_BYTES = 96 * 1_024;
const AUTH_FILE_MAX_BYTES = 128 * 1_024;

type DevicePrompt = Readonly<{
  verificationUri: typeof CODEX_DEVICE_AUTH_URI;
  userCode: string;
  expiresAt: number;
}>;

type SpawnLogin = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcessWithoutNullStreams;

function stripTerminalFormatting(value: string): string {
  // Codex colors the URL and code. Remove only terminal CSI sequences; the
  // resulting text remains bounded and is never logged or returned verbatim.
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseCodexDevicePrompt(
  value: string,
  startedAt: number,
): DevicePrompt | null {
  const plain = stripTerminalFormatting(value);
  if (!plain.includes(CODEX_DEVICE_AUTH_URI)) return null;
  const userCode = plain.match(DEVICE_CODE)?.[0];
  if (!userCode) return null;
  return {
    verificationUri: CODEX_DEVICE_AUTH_URI,
    userCode,
    expiresAt: startedAt + 15 * 60_000,
  };
}

function enrollmentEnvironment(
  home: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_CA_CERTIFICATE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "TERM",
    "CI",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  environment.PATH =
    source.PATH?.trim() ||
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  environment.HOME = home;
  environment.CODEX_HOME = home;
  environment.XDG_CONFIG_HOME = join(home, "xdg-config");
  environment.XDG_CACHE_HOME = join(home, "xdg-cache");
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GH_PROMPT_DISABLED = "1";
  mkdirSync(environment.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(environment.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
  return environment;
}

export async function enrollCodexDeviceSession(
  options: {
    bin?: string;
    root?: string;
    environment?: NodeJS.ProcessEnv;
    spawnLogin?: SpawnLogin;
    now?: () => number;
    onPrompt?: (prompt: DevicePrompt) => Promise<void> | void;
    publish?: (
      authJson: string,
    ) => Promise<{ version: number; tokenExpiresAt: number }>;
  } = {},
): Promise<{ status: "connected"; tokenExpiresAt: number }> {
  const environment = options.environment ?? process.env;
  const bin = options.bin ?? environment.CODEX_BIN ?? "codex";
  const root = options.root ?? "/tmp/jarvis-codex-enrollment";
  const now = options.now ?? Date.now;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(root, "device-"));
  const startedAt = now();
  let output = "";
  let prompt: DevicePrompt | null = null;
  let promptPublication = Promise.resolve();
  const spawnLogin =
    options.spawnLogin ??
    ((command, args, spawnOptions) =>
      spawn(
        command,
        [...args],
        spawnOptions,
      ) as ChildProcessWithoutNullStreams);

  try {
    const child = spawnLogin(bin, ["login", "--device-auth"], {
      cwd: home,
      env: enrollmentEnvironment(home, environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const observe = (chunk: Buffer | string) => {
      output += String(chunk);
      if (Buffer.byteLength(output, "utf8") > LOGIN_OUTPUT_MAX_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      const candidate = parseCodexDevicePrompt(output, startedAt);
      if (!candidate) return;
      if (prompt && prompt.userCode !== candidate.userCode) {
        child.kill("SIGKILL");
        return;
      }
      if (!prompt) {
        prompt = candidate;
        promptPublication = Promise.resolve(options.onPrompt?.(candidate));
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, LOGIN_TIMEOUT_MS);
      timer.unref?.();
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await promptPublication;
    if (exitCode !== 0 || !prompt)
      throw new Error("Codex device enrollment did not complete");

    const authPath = join(home, "auth.json");
    const stat = lstatSync(authPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 2 ||
      stat.size > AUTH_FILE_MAX_BYTES
    ) {
      throw new Error(
        "Codex device enrollment did not produce a valid auth file",
      );
    }
    const authJson = readFileSync(authPath, "utf8");
    const auth = parseChatgptSubscriptionAuthText(authJson);
    const published = options.publish
      ? await options.publish(authJson)
      : await (
          await productionSubscriptionSessionController(bin, environment)
        ).reseed(auth);
    return { status: "connected", tokenExpiresAt: published.tokenExpiresAt };
  } finally {
    // The enrolled refresh token is committed only into the encrypted session
    // store. The temporary Codex home is removed even after timeout/failure.
    rmSync(home, { recursive: true, force: true });
  }
}

export const codexAuthEnrollment = task({
  id: "jarvis-codex-auth-enrollment",
  maxDuration: 17 * 60,
  retry: { maxAttempts: 0 },
  queue: { name: "jarvis-codex-auth-enrollment", concurrencyLimit: 1 },
  run: async () => {
    metadata.set("authEnrollment", { status: "starting" });
    await metadata.flush();
    const result = await enrollCodexDeviceSession({
      onPrompt: async (prompt) => {
        metadata.set("authEnrollment", { status: "waiting", ...prompt });
        await metadata.flush();
      },
    });
    metadata.set("authEnrollment", {
      status: "connected",
      tokenExpiresAt: result.tokenExpiresAt,
    });
    await metadata.flush();
    return result;
  },
});
