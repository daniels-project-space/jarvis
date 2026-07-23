import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { BoundedJsonLineDecoder } from "../lib/bounded-json-lines";
import {
  assertExactResponseOrigin,
  hasExactKeys,
  isJsonRecord,
  readBoundedResponseBytes,
  readBoundedResponseJson,
} from "../lib/bounded-json";
import { vaultService } from "../lib/vault-client";
import { requireVaultBrokerSubscriptionSource } from "./subscription-source";
import {
  canonicalAuthJson,
  isUsableManagedSessionRotation,
  parseChatgptSubscriptionAuth,
  parseChatgptSubscriptionAuthText,
  subscriptionAccessTokenExpiresAt,
  type ChatgptSubscriptionAuth,
} from "./subscription-auth";
import {
  AesGcmSessionSnapshotCipher,
  ManagedSubscriptionSessionController,
  SubscriptionSessionError,
  validateSessionState,
  type SessionState,
  type SessionStateStore,
  type VersionedSessionState,
} from "./subscription-session";

const SESSION_SERVICE = "codex-session";
const STATE_KEY = "managed-codex-session/state.json";
const ROTATION_TIMEOUT_MS = 90_000;
export const R2_TEMPORARY_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;
export const R2_TEMPORARY_CREDENTIAL_RENEWAL_SKEW_MS = 5 * 60_000;
const R2_BROKER_TIMEOUT_MS = 10_000;
const R2_REQUEST_TIMEOUT_MS = 10_000;
const R2_STATE_MAX_BYTES = 32 * 1_024;
const R2_SNAPSHOT_MAX_BYTES = 256 * 1_024;
const CLOUDFLARE_BROKER_RESPONSE_MAX_BYTES = 64 * 1_024;
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const ROTATION_PROTOCOL_MAX_LINE_BYTES = 64 * 1_024;

type SessionSecrets = {
  R2_ACCOUNT_ID: string;
  R2_PARENT_API_TOKEN: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  SESSION_ENCRYPTION_KEY_B64: string;
  CODEX_AUTH_JSON_B64: string;
};

export function parseSessionControllerSecrets(value: Record<string, string>): SessionSecrets {
  const keys = [
    "R2_ACCOUNT_ID",
    "R2_PARENT_API_TOKEN",
    "R2_PARENT_ACCESS_KEY_ID",
    "R2_ENDPOINT",
    "R2_BUCKET",
    "SESSION_ENCRYPTION_KEY_B64",
    "CODEX_AUTH_JSON_B64",
  ] as const;
  if (keys.some((key) => !value[key])
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !(keys as readonly string[]).includes(key))) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  // Ambiguous legacy S3 credentials are rejected even when the broker fields
  // are present. The production path must never silently fall back to them.
  if (value.R2_ACCESS_KEY_ID || value.R2_SECRET_ACCESS_KEY || value.R2_SESSION_TOKEN) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  // The existing `jarvis` bucket has a public r2.dev domain. Session ciphertext
  // belongs in a dedicated private bucket with a bucket-scoped token.
  if (value.R2_BUCKET === "jarvis" || /r2\.dev/i.test(value.R2_ENDPOINT)) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  if (!/^[a-f0-9]{32}$/i.test(value.R2_ACCOUNT_ID)) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value.R2_ENDPOINT);
  } catch {
    throw new SubscriptionSessionError("configuration_missing");
  }
  const storageSuffix = ".r2.cloudflarestorage.com";
  if (endpoint.protocol !== "https:"
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname !== "/" && endpoint.pathname !== "")
    || !endpoint.hostname.endsWith(storageSuffix)
    || endpoint.hostname.split(".")[0] !== value.R2_ACCOUNT_ID.toLowerCase()) {
    throw new SubscriptionSessionError("configuration_missing");
  }
  return {
    R2_ACCOUNT_ID: value.R2_ACCOUNT_ID,
    R2_PARENT_API_TOKEN: value.R2_PARENT_API_TOKEN,
    R2_PARENT_ACCESS_KEY_ID: value.R2_PARENT_ACCESS_KEY_ID,
    R2_ENDPOINT: endpoint.origin,
    R2_BUCKET: value.R2_BUCKET,
    SESSION_ENCRYPTION_KEY_B64: value.SESSION_ENCRYPTION_KEY_B64,
    CODEX_AUTH_JSON_B64: value.CODEX_AUTH_JSON_B64,
  };
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
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly aws: AwsClient,
    endpoint: string,
    bucket: string,
    options: { timeoutMs?: number } = {},
  ) {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new SubscriptionSessionError("configuration_missing"); }
    if (parsed.protocol !== "https:" || parsed.origin !== endpoint.replace(/\/$/, "")
      || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(parsed.hostname)
      || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new SubscriptionSessionError("configuration_missing");
    }
    this.origin = parsed.origin;
    this.base = `${this.origin}/${encodeURIComponent(bucket)}`;
    this.timeoutMs = options.timeoutMs ?? R2_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new SubscriptionSessionError("configuration_missing");
    }
  }

  private url(key: string): string {
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async readState(): Promise<VersionedSessionState> {
    const response = await this.request(STATE_KEY, {
      headers: { "cache-control": "no-store" }, redirect: "error",
    });
    if (response.status === 404) return { value: null, etag: null };
    assertR2Response(response);
    const etag = response.headers.get("etag");
    if (!etag) throw new SubscriptionSessionError("snapshot_corrupt");
    try {
      const value = await readBoundedResponseJson(response, R2_STATE_MAX_BYTES) as SessionState;
      validateSessionState(value);
      return { value, etag };
    } catch {
      throw new SubscriptionSessionError("snapshot_corrupt");
    }
  }

  async compareExchangeState(
    expectedEtag: string | null,
    value: SessionState,
  ): Promise<{ ok: boolean; etag?: string }> {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.byteLength > R2_STATE_MAX_BYTES) throw new SubscriptionSessionError("snapshot_corrupt");
    const response = await this.request(STATE_KEY, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        "cache-control": "no-store",
        [expectedEtag === null ? "if-none-match" : "if-match"]: expectedEtag ?? "*",
      },
      body: body as unknown as BodyInit,
      redirect: "error",
    });
    if (response.status === 409 || response.status === 412) return { ok: false };
    assertR2Response(response);
    const etag = response.headers.get("etag");
    if (!etag) throw new SubscriptionSessionError("snapshot_corrupt");
    return { ok: true, etag };
  }

  async putSnapshotIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    if (value.byteLength > R2_SNAPSHOT_MAX_BYTES) throw new SubscriptionSessionError("snapshot_corrupt");
    const response = await this.request(key, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(value.byteLength),
        "cache-control": "no-store",
        "if-none-match": "*",
      },
      body: value as unknown as BodyInit,
      redirect: "error",
    });
    if (response.status === 409 || response.status === 412) return false;
    assertR2Response(response);
    return true;
  }

  async getSnapshot(key: string): Promise<Uint8Array | null> {
    const response = await this.request(key, {
      headers: { "cache-control": "no-store" },
      redirect: "error",
    });
    if (response.status === 404) return null;
    assertR2Response(response);
    try {
      return await readBoundedResponseBytes(response, R2_SNAPSHOT_MAX_BYTES);
    } catch {
      throw new SubscriptionSessionError("snapshot_corrupt");
    }
  }

  private async request(key: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.aws.fetch(this.url(key), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      assertExactResponseOrigin(response, this.origin);
    } catch (error) {
      if (error instanceof R2SessionCredentialRejectedError || error instanceof SubscriptionSessionError) throw error;
      throw new SubscriptionSessionError("session_store_unavailable");
    }
    return response;
  }
}

/** Internal signal used only to replace a rejected temporary S3 client. */
export class R2SessionCredentialRejectedError extends Error {
  readonly name = "R2SessionCredentialRejectedError";
  constructor() {
    super("R2 session temporary credential was rejected");
  }
}

function assertR2Response(response: Response): asserts response is Response {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new R2SessionCredentialRejectedError();
  }
  // Never include a provider response body, request URL, signed headers, or
  // credential fields in an exception that can reach a Trigger result.
  throw new SubscriptionSessionError("session_store_unavailable");
}

export type TemporaryR2Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
};

export interface TemporaryR2CredentialBroker {
  issue(): Promise<TemporaryR2Credentials>;
}

type BrokerFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type MillisecondClock = { now(): number };

function validCredentialPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\r\n\0]/.test(value);
}

/** Trusted-host Cloudflare broker. Its parent token never enters an AwsClient. */
export class CloudflareTemporaryR2CredentialBroker implements TemporaryR2CredentialBroker {
  private readonly ttlSeconds: number;
  private readonly fetcher: BrokerFetch;
  private readonly clock: MillisecondClock;
  private readonly timeoutMs: number;

  constructor(private readonly config: {
    accountId: string;
    parentApiToken: string;
    parentAccessKeyId: string;
    bucket: string;
  }, options: {
    ttlSeconds?: number;
    fetcher?: BrokerFetch;
    clock?: MillisecondClock;
    timeoutMs?: number;
  } = {}) {
    this.ttlSeconds = options.ttlSeconds ?? R2_TEMPORARY_CREDENTIAL_TTL_SECONDS;
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timeoutMs = options.timeoutMs ?? R2_BROKER_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.ttlSeconds) || this.ttlSeconds < 60 || this.ttlSeconds > 604_800) {
      throw new SubscriptionSessionError("configuration_missing");
    }
    if (!/^[a-f0-9]{32}$/i.test(config.accountId)
      || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)
      || !validCredentialPart(config.parentApiToken)
      || !validCredentialPart(config.parentAccessKeyId)) {
      throw new SubscriptionSessionError("configuration_missing");
    }
  }

  async issue(): Promise<TemporaryR2Credentials> {
    const issuedAt = this.clock.now();
    const url = `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${encodeURIComponent(this.config.accountId)}/r2/temp-access-credentials`;
    const body = JSON.stringify({
      bucket: this.config.bucket,
      parentAccessKeyId: this.config.parentAccessKeyId,
      permission: "object-read-write",
      ttlSeconds: this.ttlSeconds,
      prefixes: ["managed-codex-session/"],
    });
    let response: Response;
    try {
      response = await this.fetcher(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.parentApiToken}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body, "utf8")),
          },
          body,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      assertExactResponseOrigin(response, CLOUDFLARE_API_ORIGIN);
    } catch {
      throw new SubscriptionSessionError("credential_broker_unavailable");
    }
    let payload: unknown;
    try {
      payload = await readBoundedResponseJson(response, CLOUDFLARE_BROKER_RESPONSE_MAX_BYTES);
    } catch {
      throw new SubscriptionSessionError("credential_broker_unavailable");
    }
    if (!response.ok || !isJsonRecord(payload)
      || !hasExactKeys(payload, ["success", "result"], ["errors", "messages"])
      || payload.success !== true || !isJsonRecord(payload.result)
      || !hasExactKeys(payload.result, ["accessKeyId", "secretAccessKey", "sessionToken"])
      || !validCredentialPart(payload.result.accessKeyId)
      || !validCredentialPart(payload.result.secretAccessKey)
      || !validCredentialPart(payload.result.sessionToken)) {
      throw new SubscriptionSessionError("credential_broker_unavailable");
    }
    return {
      accessKeyId: payload.result.accessKeyId,
      secretAccessKey: payload.result.secretAccessKey,
      sessionToken: payload.result.sessionToken,
      // The API response has no expiry field. Measuring from request start is
      // conservative even if Cloudflare begins the TTL before responding.
      expiresAt: issuedAt + this.ttlSeconds * 1_000,
    };
  }
}

type R2StoreLease = {
  generation: number;
  expiresAt: number;
  store: SessionStateStore;
};

type R2StoreFactory = (credentials: TemporaryR2Credentials) => SessionStateStore;

/**
 * Stable controller store facade backed by replaceable short-lived clients.
 * Valid clients remain usable during proactive renewal. At expiry, all local
 * callers share one renewal promise; an auth rejection gets exactly one retry
 * through the same single-flight path.
 */
export class RenewingR2SessionStateStore implements SessionStateStore {
  private current: R2StoreLease | null = null;
  private renewal: Promise<R2StoreLease> | null = null;
  private nextGeneration = 1;
  private readonly clock: MillisecondClock;
  private readonly renewalSkewMs: number;

  constructor(
    private readonly broker: TemporaryR2CredentialBroker,
    private readonly createStore: R2StoreFactory,
    options: { clock?: MillisecondClock; renewalSkewMs?: number } = {},
  ) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.renewalSkewMs = options.renewalSkewMs ?? R2_TEMPORARY_CREDENTIAL_RENEWAL_SKEW_MS;
    if (!Number.isSafeInteger(this.renewalSkewMs) || this.renewalSkewMs < 0) {
      throw new SubscriptionSessionError("configuration_missing");
    }
  }

  private startRenewal(): Promise<R2StoreLease> {
    if (this.renewal) return this.renewal;
    const pending = (async () => {
      let credentials: TemporaryR2Credentials;
      try {
        credentials = await this.broker.issue();
      } catch {
        throw new SubscriptionSessionError("credential_broker_unavailable");
      }
      if (!Number.isSafeInteger(credentials.expiresAt) || credentials.expiresAt <= this.clock.now()
        || !validCredentialPart(credentials.accessKeyId)
        || !validCredentialPart(credentials.secretAccessKey)
        || !validCredentialPart(credentials.sessionToken)) {
        throw new SubscriptionSessionError("credential_broker_unavailable");
      }
      let store: SessionStateStore;
      try {
        store = this.createStore(credentials);
      } catch {
        throw new SubscriptionSessionError("credential_broker_unavailable");
      }
      const lease = { generation: this.nextGeneration++, expiresAt: credentials.expiresAt, store };
      this.current = lease;
      return lease;
    })();
    this.renewal = pending;
    void pending.then(
      () => { if (this.renewal === pending) this.renewal = null; },
      () => { if (this.renewal === pending) this.renewal = null; },
    );
    return pending;
  }

  private async storeForRequest(): Promise<R2StoreLease> {
    const current = this.current;
    const now = this.clock.now();
    if (current && current.expiresAt > now) {
      if (current.expiresAt <= now + this.renewalSkewMs && !this.renewal) {
        // Do not pause an acquire while its existing credential is still
        // valid. A failure is retried synchronously once expiry is reached.
        void this.startRenewal().catch(() => undefined);
      }
      return current;
    }
    return await this.startRenewal();
  }

  private async replacementForRejected(rejected: R2StoreLease): Promise<R2StoreLease> {
    const current = this.current;
    if (current && current.generation !== rejected.generation && current.expiresAt > this.clock.now()) {
      return current;
    }
    if (current?.generation === rejected.generation) this.current = null;
    return await this.startRenewal();
  }

  private boundedStoreError(error: unknown): never {
    if (error instanceof SubscriptionSessionError) throw error;
    throw new SubscriptionSessionError("session_store_unavailable");
  }

  private async execute<T>(operation: (store: SessionStateStore) => Promise<T>): Promise<T> {
    let lease: R2StoreLease;
    try {
      lease = await this.storeForRequest();
    } catch (error) {
      return this.boundedStoreError(error);
    }
    try {
      return await operation(lease.store);
    } catch (error) {
      if (!(error instanceof R2SessionCredentialRejectedError)) return this.boundedStoreError(error);
    }
    let replacement: R2StoreLease;
    try {
      replacement = await this.replacementForRejected(lease);
    } catch {
      throw new SubscriptionSessionError("credential_broker_unavailable");
    }
    try {
      return await operation(replacement.store);
    } catch (error) {
      if (error instanceof R2SessionCredentialRejectedError) {
        if (this.current?.generation === replacement.generation) this.current = null;
        throw new SubscriptionSessionError("credential_broker_unavailable");
      }
      return this.boundedStoreError(error);
    }
  }

  readState(): Promise<VersionedSessionState> {
    return this.execute((store) => store.readState());
  }

  compareExchangeState(expectedEtag: string | null, value: SessionState): Promise<{ ok: boolean; etag?: string }> {
    return this.execute((store) => store.compareExchangeState(expectedEtag, value));
  }

  putSnapshotIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    return this.execute((store) => store.putSnapshotIfAbsent(key, value));
  }

  getSnapshot(key: string): Promise<Uint8Array | null> {
    return this.execute((store) => store.getSnapshot(key));
  }
}

type RotationSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

const CHATGPT_PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "business",
  "enterprise_cbp_usage_based", "enterprise", "edu", "unknown",
]);

function validateInitializeResult(value: unknown, codexHome: string): void {
  if (!isJsonRecord(value)
    || !hasExactKeys(value, ["codexHome", "platformFamily", "platformOs", "userAgent"])
    || typeof value.codexHome !== "string" || resolve(value.codexHome) !== resolve(codexHome)
    || value.platformFamily !== "unix" || value.platformOs !== "linux"
    || typeof value.userAgent !== "string" || !value.userAgent || value.userAgent.length > 512) {
    throw new Error("invalid initialize result");
  }
}

function validateAccountReadResult(value: unknown): void {
  if (!isJsonRecord(value)
    || !hasExactKeys(value, ["account", "requiresOpenaiAuth"])
    || value.requiresOpenaiAuth !== true || !isJsonRecord(value.account)
    || !hasExactKeys(value.account, ["type", "email", "planType"])
    || value.account.type !== "chatgpt"
    || !(value.account.email === null
      || (typeof value.account.email === "string" && value.account.email.length <= 320))
    || typeof value.account.planType !== "string" || !CHATGPT_PLAN_TYPES.has(value.account.planType)) {
    throw new Error("invalid account/read result");
  }
}

function responseForId(value: unknown, id: number): { result?: unknown; error?: unknown } | null {
  if (!isJsonRecord(value) || value.id !== id) return null;
  if (hasExactKeys(value, ["id", "result"])) return { result: value.result };
  if (hasExactKeys(value, ["id", "error"])) return { error: value.error };
  throw new Error("invalid app-server response envelope");
}

function validIgnoredRotationNotification(value: unknown): boolean {
  return isJsonRecord(value)
    && hasExactKeys(value, ["method", "params"])
    && typeof value.method === "string"
    && isJsonRecord(value.params);
}

function rotationEnv(
  codexHome: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const allow = [
    "PATH", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "TERM", "CI", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const key of allow) if (source[key] !== undefined) env[key] = source[key];
  env.PATH = source.PATH?.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  env.HOME = codexHome;
  env.CODEX_HOME = codexHome;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GH_PROMPT_DISABLED = "1";
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
  options: {
    root?: string;
    spawnProcess?: RotationSpawn;
    timeoutMs?: number;
    requiredUntil?: number;
    environment?: Readonly<Record<string, string | undefined>>;
    markEffect?: () => Promise<void>;
    clearUnwrittenEffect?: () => Promise<void>;
  } = {},
): Promise<ChatgptSubscriptionAuth> {
  const root = options.root ?? "/home/node/.jarvis-codex-session-controller";
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(root, "writer-"));
  const authPath = join(home, "auth.json");
  writeFileSync(authPath, canonicalAuthJson(current), { mode: 0o600 });
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  let refreshTokenReused = false;
  let diagnosticTail = "";
  const observeDiagnostic = (value: unknown) => {
    const text = `${diagnosticTail}${String(value ?? "").slice(-512)}`;
    if (/refresh[_ -]?token[_ -]?reused|refresh token (?:was )?(?:already )?used/i.test(text)) {
      refreshTokenReused = true;
    }
    // Retain only enough boundary text to recognize a split error code. This
    // buffer is never emitted or persisted.
    diagnosticTail = text.slice(-80);
  };
  try {
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let terminationTimer: ReturnType<typeof setTimeout> | null = null;
      let handling = Promise.resolve();
      let initialized = false;
      let accountRequested = false;
      const decoder = new BoundedJsonLineDecoder(ROTATION_PROTOCOL_MAX_LINE_BYTES);
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        resolvePromise();
      };
      const finishAfterHandling = () => { void handling.finally(finish); };
      try {
        child = spawnProcess(bin, ["app-server", "--listen", "stdio://"], {
          cwd: home,
          env: rotationEnv(home, options.environment),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        finish();
        return;
      }
      const stop = (signal: NodeJS.Signals) => {
        try { child.kill(signal); } catch { /* already gone */ }
        if (!terminationTimer) {
          terminationTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
            finish();
          }, 1_000);
        }
      };
      timer = setTimeout(() => {
        stop("SIGKILL");
      }, Math.max(1, options.timeoutMs ?? ROTATION_TIMEOUT_MS));
      child.stderr.on("data", observeDiagnostic);
      child.stdin.on("error", () => stop("SIGKILL"));
      child.once("error", finishAfterHandling);
      child.once("close", finishAfterHandling);
      child.stdout.on("data", (chunk: Buffer) => {
        let messages: unknown[];
        try { messages = decoder.push(chunk); }
        catch { stop("SIGKILL"); return; }
        for (const message of messages) {
          handling = handling.then(async () => {
            const initialize = responseForId(message, 1);
            if (initialize) {
              if (initialized || accountRequested || initialize.error !== undefined) {
                if (initialize.error !== undefined) observeDiagnostic(JSON.stringify(initialize.error));
                throw new Error("initialize rejected");
              }
              validateInitializeResult(initialize.result, home);
              child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
              initialized = true;
              await (options.markEffect?.() ?? Promise.resolve());
              try {
                child.stdin.write(`${JSON.stringify({
                  id: 2,
                  method: "account/read",
                  params: { refreshToken: true },
                })}\n`);
                accountRequested = true;
              } catch (error) {
                await (options.clearUnwrittenEffect?.() ?? Promise.resolve());
                throw error;
              }
              return;
            }
            const account = responseForId(message, 2);
            if (account) {
              if (!initialized || !accountRequested || account.error !== undefined) {
                if (account.error !== undefined) observeDiagnostic(JSON.stringify(account.error));
                throw new Error("account/read rejected");
              }
              validateAccountReadResult(account.result);
              // account/read persists managed auth before replying. A lost
              // reply is recovered only by the exact auth-file transition.
              stop("SIGTERM");
              return;
            }
            if (!validIgnoredRotationNotification(message)) throw new Error("invalid app-server message");
          }).catch(() => stop("SIGKILL"));
        }
      });
      child.stdout.once("end", () => {
        try { decoder.finish(); } catch { stop("SIGKILL"); }
      });
      try {
        child.stdin.write(`${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "jarvis-session-controller", title: "Jarvis Session Controller", version: "1.0.0" },
            capabilities: { experimentalApi: false },
          },
        })}\n`);
      } catch {
        stop("SIGKILL");
      }
    });

    let updated: ChatgptSubscriptionAuth;
    try {
      updated = parseChatgptSubscriptionAuthText(readFileSync(authPath, "utf8"));
      subscriptionAccessTokenExpiresAt(updated);
    } catch {
      throw new SubscriptionSessionError("rotation_failed");
    }
    if (refreshTokenReused) {
      throw new SubscriptionSessionError("refresh_token_reused");
    }
    const requiredUntil = options.requiredUntil
      ?? Math.max(Date.now() + 1, subscriptionAccessTokenExpiresAt(current) + 1);
    if (isUsableManagedSessionRotation(current, updated, requiredUntil)) return updated;
    throw new SubscriptionSessionError("rotation_failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

let controllerPromise: Promise<ManagedSubscriptionSessionController> | null = null;

export function productionSubscriptionSessionController(
  bin: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: { loadSecrets?: (service: string) => Promise<Record<string, string>> } = {},
): Promise<ManagedSubscriptionSessionController> {
  // Check on every call, including after the singleton has warmed. A host
  // cannot inherit or reuse this controller unless its deployment explicitly
  // selected the brokered source.
  requireVaultBrokerSubscriptionSource(environment);
  if (!dependencies.loadSecrets && controllerPromise) return controllerPromise;
  const creating = (async () => {
    let values: Record<string, string>;
    try {
      values = await (dependencies.loadSecrets ?? vaultService)(SESSION_SERVICE);
    } catch {
      throw new SubscriptionSessionError("configuration_missing");
    }
    const secrets = parseSessionControllerSecrets(values);
    const key = canonicalBase64Bytes(secrets.SESSION_ENCRYPTION_KEY_B64, 32);
    const broker = new CloudflareTemporaryR2CredentialBroker({
      accountId: secrets.R2_ACCOUNT_ID,
      parentApiToken: secrets.R2_PARENT_API_TOKEN,
      parentAccessKeyId: secrets.R2_PARENT_ACCESS_KEY_ID,
      bucket: secrets.R2_BUCKET,
    });
    const store = new RenewingR2SessionStateStore(broker, (credentials) => {
      const aws = new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        service: "s3",
        region: "auto",
      });
      return new R2SessionStateStore(aws, secrets.R2_ENDPOINT, secrets.R2_BUCKET);
    });
    return new ManagedSubscriptionSessionController({
      store,
      cipher: new AesGcmSessionSnapshotCipher(key),
      bootstrap: async () => parseChatgptSubscriptionAuth(secrets.CODEX_AUTH_JSON_B64),
    rotate: (auth, context) => rotateManagedSessionWithCodex(bin, auth, {
      requiredUntil: context.requiredUntil,
      markEffect: context.markEffect,
      clearUnwrittenEffect: context.clearUnwrittenEffect,
    }),
    });
  })().catch((error) => {
    if (!dependencies.loadSecrets) controllerPromise = null;
    if (error instanceof SubscriptionSessionError) throw error;
    throw new SubscriptionSessionError("configuration_missing");
  });
  if (!dependencies.loadSecrets) controllerPromise = creating;
  return creating;
}
