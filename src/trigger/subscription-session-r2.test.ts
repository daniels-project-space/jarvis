import { describe, expect, it, vi } from "vitest";
import {
  CloudflareTemporaryR2CredentialBroker,
  R2SessionStateStore,
  R2SessionCredentialRejectedError,
  R2_TEMPORARY_CREDENTIAL_TTL_SECONDS,
  RenewingR2SessionStateStore,
  parseSessionControllerSecrets,
  productionSubscriptionSessionController,
  type TemporaryR2CredentialBroker,
  type TemporaryR2Credentials,
} from "./subscription-session-r2";
import {
  MemorySessionStateStore,
  SESSION_STATE_SCHEMA,
  SubscriptionSessionError,
  type SessionState,
  type SessionStateStore,
} from "./subscription-session";

const ACCOUNT_ID = "a".repeat(32);
const R2_ORIGIN = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const CLOUDFLARE_BROKER_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`;

function responseAt(url: string, body?: BodyInit | null, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}
const STATE: SessionState = {
  schema: SESSION_STATE_SCHEMA,
  revision: 1,
  fence: 0,
  writer: null,
  snapshot: null,
  rotationAttempt: null,
};

function temporary(generation: number, expiresAt: number): TemporaryR2Credentials {
  return {
    accessKeyId: `temporary-access-${generation}`,
    secretAccessKey: `temporary-secret-${generation}`,
    sessionToken: `temporary-session-${generation}`,
    expiresAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Cloudflare R2 temporary credential broker", () => {
  it("mints only a six-hour prefix-scoped session-token credential", async () => {
    const now = { value: 1_900_000_000_000 };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return responseAt(CLOUDFLARE_BROKER_URL, JSON.stringify({
        success: true,
        result: {
          accessKeyId: "temporary-access",
          secretAccessKey: "temporary-secret",
          sessionToken: "temporary-session",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const broker = new CloudflareTemporaryR2CredentialBroker({
      accountId: ACCOUNT_ID,
      parentApiToken: "parent-api-token-never-forwarded",
      parentAccessKeyId: "parent-access-id-never-forwarded",
      bucket: "jarvis-codex-session-private",
    }, { fetcher, clock: { now: () => now.value } });

    const credentials = await broker.issue();
    expect(credentials).toEqual({
      accessKeyId: "temporary-access",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-session",
      expiresAt: now.value + R2_TEMPORARY_CREDENTIAL_TTL_SECONDS * 1_000,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/temp-access-credentials`);
    expect(init?.headers).toMatchObject({ authorization: "Bearer parent-api-token-never-forwarded" });
    expect(init?.headers).toMatchObject({ "content-length": String(Buffer.byteLength(String(init?.body))) });
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      bucket: "jarvis-codex-session-private",
      parentAccessKeyId: "parent-access-id-never-forwarded",
      permission: "object-read-write",
      ttlSeconds: R2_TEMPORARY_CREDENTIAL_TTL_SECONDS,
      prefixes: ["managed-codex-session/"],
    });
  });

  it("rejects static S3 fallback configuration and malformed private endpoints", () => {
    const valid = {
      R2_ACCOUNT_ID: ACCOUNT_ID,
      R2_PARENT_API_TOKEN: "parent-api-token",
      R2_PARENT_ACCESS_KEY_ID: "parent-access-key-id",
      R2_ENDPOINT: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      R2_BUCKET: "jarvis-codex-session-private",
      SESSION_ENCRYPTION_KEY_B64: Buffer.alloc(32, 4).toString("base64"),
      CODEX_AUTH_JSON_B64: "canonical-bootstrap",
    };
    expect(parseSessionControllerSecrets(valid)).toMatchObject(valid);
    expect(() => parseSessionControllerSecrets({ ...valid, R2_ACCESS_KEY_ID: "static-access" }))
      .toThrow(SubscriptionSessionError);
    expect(() => parseSessionControllerSecrets({ ...valid, R2_SECRET_ACCESS_KEY: "static-secret" }))
      .toThrow(SubscriptionSessionError);
    expect(() => parseSessionControllerSecrets({ ...valid, R2_ENDPOINT: "https://public.r2.dev" }))
      .toThrow(SubscriptionSessionError);
  });

  it("returns only a bounded operator signal when minting fails", async () => {
    const leaked = "parent-api-token-and-provider-body-must-not-leak";
    const broker = new CloudflareTemporaryR2CredentialBroker({
      accountId: ACCOUNT_ID,
      parentApiToken: leaked,
      parentAccessKeyId: "parent-access-id",
      bucket: "jarvis-codex-session-private",
    }, {
      fetcher: async () => responseAt(CLOUDFLARE_BROKER_URL, JSON.stringify({ success: false, errors: [{ message: leaked }] }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    });
    let error: unknown;
    try { await broker.issue(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "credential_broker_unavailable" });
    expect(String(error)).not.toContain(leaked);
  });

  it("rejects wrong-origin, duplicate, oversized and stalled broker responses", async () => {
    const config = {
      accountId: ACCOUNT_ID,
      parentApiToken: "parent-api-token",
      parentAccessKeyId: "parent-access-id",
      bucket: "jarvis-codex-session-private",
    };
    const wrongOrigin = new CloudflareTemporaryR2CredentialBroker(config, {
      fetcher: async () => responseAt("https://hostile.example/credentials", "{}", {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    await expect(wrongOrigin.issue()).rejects.toMatchObject({ code: "credential_broker_unavailable" });

    const duplicate = new CloudflareTemporaryR2CredentialBroker(config, {
      fetcher: async () => responseAt(CLOUDFLARE_BROKER_URL,
        '{"success":true,"success":false,"result":{}}',
        { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(duplicate.issue()).rejects.toMatchObject({ code: "credential_broker_unavailable" });

    const oversized = new CloudflareTemporaryR2CredentialBroker(config, {
      fetcher: async () => responseAt(CLOUDFLARE_BROKER_URL, null, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(65 * 1_024) },
      }),
    });
    await expect(oversized.issue()).rejects.toMatchObject({ code: "credential_broker_unavailable" });

    const stalled = new CloudflareTemporaryR2CredentialBroker(config, {
      timeoutMs: 5,
      fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    await expect(stalled.issue()).rejects.toMatchObject({ code: "credential_broker_unavailable" });
  });
});

describe("R2 session request transport", () => {
  it("refuses redirects for every signed state and snapshot request", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return responseAt(String(input), null, { status: 412 });
      return responseAt(String(input), null, { status: 404 });
    });
    const store = new R2SessionStateStore(
      { fetch: fetcher } as never,
      R2_ORIGIN,
      "jarvis-codex-session-private",
    );

    await store.readState();
    await store.compareExchangeState(null, STATE);
    await store.putSnapshotIfAbsent("managed-codex-session/snapshots/test", new Uint8Array([1]));
    await store.getSnapshot("managed-codex-session/snapshots/test");

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("forces identity representations for state and snapshot reads", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      if (String(input).endsWith("/managed-codex-session/state.json")) {
        return responseAt(String(input), JSON.stringify(STATE), {
          status: 200,
          headers: { etag: "\"state-etag\"", "content-type": "application/json" },
        });
      }
      return responseAt(String(input), new Uint8Array([1]), { status: 200 });
    });
    const store = new R2SessionStateStore(
      { fetch: fetcher } as never,
      R2_ORIGIN,
      "jarvis-codex-session-private",
    );

    await store.readState();
    await store.getSnapshot("managed-codex-session/snapshots/test");

    expect(fetcher.mock.calls).toHaveLength(2);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      `${R2_ORIGIN}/jarvis-codex-session-private/managed-codex-session/state.json`,
    );
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("accept-encoding")).toBe("identity");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("accept-encoding")).toBe("identity");
  });

  it("rejects weak or malformed state ETags before CAS can use them", async () => {
    for (const etag of ["W/\"gzip-etag\"", "gzip-etag", "\"unterminated", "\"\"", ""]) {
      const store = new R2SessionStateStore({
        fetch: async (input: RequestInfo | URL) => responseAt(
          String(input),
          JSON.stringify(STATE),
          { status: 200, headers: { etag, "content-type": "application/json" } },
        ),
      } as never, R2_ORIGIN, "jarvis-codex-session-private");

      await expect(store.readState()).rejects.toMatchObject({ code: "snapshot_corrupt" });
    }
  });

  it("rejects invalid state ETags supplied to or returned from compare-exchange", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => responseAt(
      String(input),
      null,
      { status: 200, headers: { etag: "W/\"gzip-etag\"" } },
    ));
    const store = new R2SessionStateStore(
      { fetch: fetcher } as never,
      R2_ORIGIN,
      "jarvis-codex-session-private",
    );

    await expect(store.compareExchangeState("W/\"gzip-etag\"", STATE))
      .rejects.toMatchObject({ code: "snapshot_corrupt" });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(store.compareExchangeState("\"current-etag\"", STATE))
      .rejects.toMatchObject({ code: "snapshot_corrupt" });
  });

  it("rejects wrong-origin, duplicate, oversized and stalled state responses", async () => {
    const stateBody = JSON.stringify(STATE);
    const wrongOrigin = new R2SessionStateStore({ fetch: async () => responseAt(
      "https://hostile.example/state.json",
      stateBody,
      { status: 200, headers: { etag: "\"one\"", "content-type": "application/json" } },
    ) } as never, R2_ORIGIN, "jarvis-codex-session-private");
    await expect(wrongOrigin.readState()).rejects.toMatchObject({ code: "session_store_unavailable" });

    const duplicate = new R2SessionStateStore({ fetch: async (input: RequestInfo | URL) => responseAt(
      String(input),
      stateBody.replace('"revision":1', '"revision":1,"revision":2'),
      { status: 200, headers: { etag: "\"two\"", "content-type": "application/json" } },
    ) } as never, R2_ORIGIN, "jarvis-codex-session-private");
    await expect(duplicate.readState()).rejects.toMatchObject({ code: "snapshot_corrupt" });

    const oversized = new R2SessionStateStore({ fetch: async (input: RequestInfo | URL) => responseAt(
      String(input), null,
      { status: 200, headers: { etag: "\"three\"", "content-type": "application/json", "content-length": String(33 * 1_024) } },
    ) } as never, R2_ORIGIN, "jarvis-codex-session-private");
    await expect(oversized.readState()).rejects.toMatchObject({ code: "snapshot_corrupt" });

    const stalled = new R2SessionStateStore({ fetch: async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) } as never, R2_ORIGIN, "jarvis-codex-session-private", { timeoutMs: 5 });
    await expect(stalled.readState()).rejects.toMatchObject({ code: "session_store_unavailable" });
  });
});

describe("production session source staging", () => {
  it("does not read retired auth variables on the real controller path", async () => {
    const retired = new Set(["CODEX_AUTH_JSON_B64", "CODEX_AUTH_JSON", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"]);
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>({
      JARVIS_CODEX_SESSION_SOURCE: "vault-broker",
    }, {
      get(target, property) {
        const name = String(property);
        if (retired.has(name)) throw new Error(`retired getter invoked: ${name}`);
        reads.push(name);
        return target[name];
      },
    });
    await expect(productionSubscriptionSessionController("/pinned/codex", environment, {
      loadSecrets: async () => { throw new Error("bounded test stop"); },
    })).rejects.toMatchObject({ code: "configuration_missing" });
    expect(reads).toEqual(["JARVIS_CODEX_SESSION_SOURCE"]);
  });
});

describe("renewing R2 session state store", () => {
  it("keeps valid access available while one proactive renewal is in flight", async () => {
    const clock = { value: 1_000 };
    const backend = new MemorySessionStateStore();
    const renewal = deferred<TemporaryR2Credentials>();
    let issues = 0;
    const broker: TemporaryR2CredentialBroker = {
      issue: vi.fn(async () => ++issues === 1 ? temporary(1, 2_000) : await renewal.promise),
    };
    const clients: string[] = [];
    const store = new RenewingR2SessionStateStore(broker, (credentials) => {
      clients.push(credentials.sessionToken);
      return backend;
    }, { clock: { now: () => clock.value }, renewalSkewMs: 200 });
    await store.readState();

    clock.value = 1_850;
    const uninterrupted = await Promise.all(Array.from({ length: 16 }, () => store.readState()));
    expect(uninterrupted.every((result) => result.value === null)).toBe(true);
    expect(issues).toBe(2);
    expect(clients).toEqual(["temporary-session-1"]);

    renewal.resolve(temporary(2, 4_000));
    await vi.waitFor(() => expect(clients).toEqual(["temporary-session-1", "temporary-session-2"]));
    clock.value = 2_001;
    await expect(store.readState()).resolves.toMatchObject({ value: null, etag: null });
    expect(issues).toBe(2);
  });

  it("crosses credential expiry with concurrent readers/writer, one renewal, and continued CAS/snapshot access", async () => {
    const clock = { value: 10_000 };
    const backend = new MemorySessionStateStore();
    const secondIssue = deferred<TemporaryR2Credentials>();
    let issues = 0;
    const broker: TemporaryR2CredentialBroker = {
      issue: vi.fn(async () => {
        issues += 1;
        return issues === 1 ? temporary(1, 11_000) : await secondIssue.promise;
      }),
    };
    const clients: string[] = [];
    const store = new RenewingR2SessionStateStore(broker, (credentials) => {
      clients.push(credentials.sessionToken);
      return backend;
    }, { clock: { now: () => clock.value }, renewalSkewMs: 0 });

    expect(await store.compareExchangeState(null, STATE)).toMatchObject({ ok: true });
    const initial = await store.readState();
    clock.value = 11_001;
    const reads = Array.from({ length: 20 }, () => store.readState());
    const write = store.compareExchangeState(initial.etag, { ...STATE, revision: 2 });
    const snapshotWrite = store.putSnapshotIfAbsent("managed-codex-session/snapshots/test", new Uint8Array([7, 8, 9]));
    await vi.waitFor(() => expect(issues).toBe(2));
    secondIssue.resolve(temporary(2, 20_000));
    const [readResults, writeResult, snapshotResult] = await Promise.all([
      Promise.all(reads), write, snapshotWrite,
    ]);

    expect(readResults).toHaveLength(20);
    expect(writeResult.ok).toBe(true);
    expect(snapshotResult).toBe(true);
    expect(await store.getSnapshot("managed-codex-session/snapshots/test")).toEqual(new Uint8Array([7, 8, 9]));
    expect(issues).toBe(2);
    expect(clients).toEqual(["temporary-session-1", "temporary-session-2"]);
  });

  it("recovers all simultaneous 401/403 operations through one replacement client", async () => {
    const clock = { value: 50_000 };
    const backend = new MemorySessionStateStore();
    let issues = 0;
    const broker: TemporaryR2CredentialBroker = {
      issue: vi.fn(async () => temporary(++issues, clock.value + 10_000)),
    };
    const rejected: SessionStateStore = {
      readState: async () => { throw new R2SessionCredentialRejectedError(); },
      compareExchangeState: async () => { throw new R2SessionCredentialRejectedError(); },
      putSnapshotIfAbsent: async () => { throw new R2SessionCredentialRejectedError(); },
      getSnapshot: async () => { throw new R2SessionCredentialRejectedError(); },
    };
    const store = new RenewingR2SessionStateStore(
      broker,
      (credentials) => credentials.accessKeyId.endsWith("-1") ? rejected : backend,
      { clock: { now: () => clock.value }, renewalSkewMs: 0 },
    );

    const results = await Promise.all(Array.from({ length: 24 }, () => store.readState()));
    expect(results.every((result) => result.value === null)).toBe(true);
    expect(issues).toBe(2);
  });

  it("fails closed after expiry when renewal fails, then permits bounded recovery", async () => {
    const clock = { value: 100_000 };
    const backend = new MemorySessionStateStore();
    const failedRenewal = deferred<TemporaryR2Credentials>();
    let issues = 0;
    let recovered = false;
    const broker: TemporaryR2CredentialBroker = {
      issue: vi.fn(async () => {
        issues += 1;
        if (issues === 1) return temporary(1, 101_000);
        if (!recovered) return await failedRenewal.promise;
        return temporary(3, 120_000);
      }),
    };
    const store = new RenewingR2SessionStateStore(broker, () => backend, {
      clock: { now: () => clock.value }, renewalSkewMs: 0,
    });
    await store.readState();
    clock.value = 101_001;
    const pending = Array.from({ length: 12 }, () => store.readState());
    await vi.waitFor(() => expect(issues).toBe(2));
    failedRenewal.reject(new Error("temporary-secret-must-not-leak"));
    const settled = await Promise.allSettled(pending);
    expect(settled.every((item) => item.status === "rejected"
      && item.reason instanceof SubscriptionSessionError
      && item.reason.code === "credential_broker_unavailable"
      && !String(item.reason).includes("temporary-secret"))).toBe(true);
    expect(issues).toBe(2);

    recovered = true;
    await expect(store.readState()).resolves.toMatchObject({ value: null, etag: null });
    expect(issues).toBe(3);
  });
});
