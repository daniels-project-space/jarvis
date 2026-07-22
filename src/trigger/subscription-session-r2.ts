import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { vaultService } from "../lib/vault-client";
import { codexReviewExecPrefix } from "./model-policy";
import {
  canonicalAuthJson,
  parseChatgptSubscriptionAuth,
  parseChatgptSubscriptionAuthText,
  subscriptionAccessTokenExpiresAt,
  subscriptionAuthDigest,
  type ChatgptSubscriptionAuth,
} from "./subscription-auth";
import {
  AesGcmSessionSnapshotCipher,
  ManagedSubscriptionSessionController,
  SubscriptionSessionError,
  type SessionState,
  type SessionStateStore,
  type VersionedSessionState,
} from "./subscription-session";

const SESSION_SERVICE = "codex-session";
const STATE_KEY = "managed-codex-session/state.json";
const ROTATION_TIMEOUT_MS = 90_000;

type SessionSecrets = {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  SESSION_ENCRYPTION_KEY_B64: string;
  CODEX_AUTH_JSON_B64: string;
};

function requiredSecrets(value: Record<string, string>): SessionSecrets {
  const keys = [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "SESSION_ENCRYPTION_KEY_B64",
    "CODEX_AUTH_JSON_B64",
  ] as const;
  if (keys.some((key) => !value[key])) throw new SubscriptionSessionError("configuration_missing");
  // The existing `jarvis` bucket has a public r2.dev domain. Session ciphertext
  // belongs in a dedicated private bucket with a bucket-scoped token.
  if (value.R2_BUCKET === "jarvis" || /r2\.dev/i.test(value.R2_ENDPOINT)) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  return value as SessionSecrets;
}

function canonicalBase64Bytes(value: string, expectedLength: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.byteLength !== expectedLength) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  return bytes;
}

export class R2SessionStateStore implements SessionStateStore {
  private readonly base: string;

  constructor(
    private readonly aws: AwsClient,
    endpoint: string,
    bucket: string,
  ) {
    this.base = `${endpoint.replace(/\/$/, "")}/${encodeURIComponent(bucket)}`;
  }

  private url(key: string): string {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async readState(): Promise<VersionedSessionState> {
    const response = await this.aws.fetch(this.url(STATE_KEY), {
      headers: { "cache-control": "no-store" },
    });
    if (response.status === 404) return { value: null, etag: null };
    if (!response.ok) throw new SubscriptionSessionError("configuration_missing");
    const etag = response.headers.get("etag");
    if (!etag) throw new SubscriptionSessionError("snapshot_corrupt");
    try {
      return { value: await response.json() as SessionState, etag };
    } catch {
      throw new SubscriptionSessionError("snapshot_corrupt");
    }
  }

  async compareExchangeState(
    expectedEtag: string | null,
    value: SessionState,
  ): Promise<{ ok: boolean; etag?: string }> {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const response = await this.aws.fetch(this.url(STATE_KEY), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "cache-control": "no-store",
        [expectedEtag === null ? "if-none-match" : "if-match"]: expectedEtag ?? "*",
      },
      body: body as unknown as BodyInit,
    });
    if (response.status === 409 || response.status === 412) return { ok: false };
    if (!response.ok) throw new SubscriptionSessionError("configuration_missing");
    const etag = response.headers.get("etag");
    if (!etag) throw new SubscriptionSessionError("snapshot_corrupt");
    return { ok: true, etag };
  }

  async putSnapshotIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    const response = await this.aws.fetch(this.url(key), {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(value.byteLength),
        "cache-control": "no-store",
        "if-none-match": "*",
      },
      body: value as unknown as BodyInit,
    });
    if (response.status === 409 || response.status === 412) return false;
    if (!response.ok) throw new SubscriptionSessionError("configuration_missing");
    return true;
  }

  async getSnapshot(key: string): Promise<Uint8Array | null> {
    const response = await this.aws.fetch(this.url(key), {
      headers: { "cache-control": "no-store" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new SubscriptionSessionError("configuration_missing");
    return new Uint8Array(await response.arrayBuffer());
  }
}

type RotationSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

function rotationEnv(codexHome: string): NodeJS.ProcessEnv {
  const allow = [
    "PATH", "LANG", "LC_ALL", "NODE_PATH", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "TERM", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.PATH = process.env.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  env.HOME = codexHome;
  env.CODEX_HOME = codexHome;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
  env.ANTHROPIC_API_KEY = "";
  env.OPENAI_API_KEY = "";
  env.CODEX_API_KEY = "";
  return env;
}

/**
 * The only process that receives a real refresh token. It has no repository,
 * tools, plugins, network-capable model tools, or controller environment. The
 * parent always re-reads auth.json, even after a non-zero child exit, so a
 * refresh written immediately before a Codex crash is still committed.
 */
export async function rotateManagedSessionWithCodex(
  bin: string,
  current: ChatgptSubscriptionAuth,
  options: { root?: string; spawnProcess?: RotationSpawn; timeoutMs?: number } = {},
): Promise<ChatgptSubscriptionAuth> {
  const root = options.root ?? "/home/node/.jarvis-codex-session-controller";
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(root, "writer-"));
  const authPath = join(home, "auth.json");
  writeFileSync(authPath, canonicalAuthJson(current), { mode: 0o600 });
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  let stderr = "";
  try {
    await new Promise<void>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(bin, [...codexReviewExecPrefix("luna"), "-"], {
          cwd: home,
          env: rotationEnv(home),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, options.timeoutMs ?? ROTATION_TIMEOUT_MS);
      child.stdout.resume();
      child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-2_000); });
      child.once("error", () => { clearTimeout(timer); resolve(); });
      child.once("close", () => { clearTimeout(timer); resolve(); });
      try {
        child.stdin.end("Reply with exactly READY. Do not call tools.\n", "utf8");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    });

    let updated: ChatgptSubscriptionAuth;
    try {
      updated = parseChatgptSubscriptionAuthText(readFileSync(authPath, "utf8"));
      subscriptionAccessTokenExpiresAt(updated);
    } catch {
      throw new SubscriptionSessionError("rotation_failed");
    }
    if (subscriptionAuthDigest(updated) !== subscriptionAuthDigest(current)) return updated;
    if (/refresh[_ -]?token[_ -]?reused|refresh token (?:was )?reused/i.test(stderr)) {
      throw new SubscriptionSessionError("refresh_token_reused");
    }
    throw new SubscriptionSessionError("rotation_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

let controllerPromise: Promise<ManagedSubscriptionSessionController> | null = null;

export function productionSubscriptionSessionController(
  bin: string,
): Promise<ManagedSubscriptionSessionController> {
  if (controllerPromise) return controllerPromise;
  controllerPromise = (async () => {
    // Old Trigger deployments may still carry this copied secret. Refuse it:
    // bootstrap must be fetched only inside the controller boundary.
    if (process.env.CODEX_AUTH_JSON_B64 !== undefined
      || process.env.CODEX_AUTH_JSON !== undefined
      || process.env.CODEX_ACCESS_TOKEN !== undefined) {
      throw new SubscriptionSessionError("configuration_missing");
    }
    const secrets = requiredSecrets(await vaultService(SESSION_SERVICE));
    const key = canonicalBase64Bytes(secrets.SESSION_ENCRYPTION_KEY_B64, 32);
    const aws = new AwsClient({
      accessKeyId: secrets.R2_ACCESS_KEY_ID,
      secretAccessKey: secrets.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    });
    const store = new R2SessionStateStore(aws, secrets.R2_ENDPOINT, secrets.R2_BUCKET);
    return new ManagedSubscriptionSessionController({
      store,
      cipher: new AesGcmSessionSnapshotCipher(key),
      bootstrap: async () => parseChatgptSubscriptionAuth(secrets.CODEX_AUTH_JSON_B64),
      rotate: (auth) => rotateManagedSessionWithCodex(bin, auth),
    });
  })().catch((error) => {
    controllerPromise = null;
    throw error;
  });
  return controllerPromise;
}
