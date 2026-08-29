import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROLLER_REFRESH_SENTINEL,
  canonicalAuthJson,
  type ChatgptSubscriptionAuth,
} from "./subscription-auth";
import {
  AesGcmSessionSnapshotCipher,
  ManagedSubscriptionSessionController,
  MemorySessionStateStore,
  SubscriptionSessionError,
  subscriptionOperatorSignal,
  type SessionRotator,
} from "./subscription-session";
import { rotateManagedSessionWithCodex } from "./subscription-session-r2";
import { CODEX_CONSUMER_REFRESH_GUARD_MS } from "./subscription-validity";

const NOW = 1_800_000_000_000;

function jwt(expiresAt: number, marker: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1_000), marker })).toString("base64url");
  return `${header}.${payload}.signature-${marker}`;
}

function auth(expiresAt: number, generation: number): ChatgptSubscriptionAuth {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: new Date(NOW - generation * 1_000).toISOString(),
    tokens: {
      access_token: jwt(expiresAt, `access-${generation}`),
      refresh_token: `managed-refresh-${generation}`,
      id_token: jwt(expiresAt + 60_000, `identity-${generation}`),
      account_id: "account-subscription",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options: {
  store?: MemorySessionStateStore;
  bootstrap?: ChatgptSubscriptionAuth;
  rotate?: SessionRotator;
  now?: { value: number };
  leaseMs?: number;
  waitMs?: number;
} = {}) {
  const now = options.now ?? { value: NOW };
  const store = options.store ?? new MemorySessionStateStore();
  const bootstrap = options.bootstrap ?? auth(now.value + 60 * 60_000, 1);
  const rotate = options.rotate ?? vi.fn(async (_current, context) => {
    await context.markEffect();
    return auth(now.value + 2 * 60 * 60_000, 2);
  });
  const controller = new ManagedSubscriptionSessionController({
    store,
    cipher: new AesGcmSessionSnapshotCipher(Buffer.alloc(32, 7)),
    bootstrap: async () => bootstrap,
    rotate,
    clock: {
      now: () => now.value,
      sleep: async (ms) => { now.value += ms; await Promise.resolve(); },
    },
    leaseMs: options.leaseMs ?? 10_000,
    waitMs: options.waitMs ?? 30_000,
    // `minimumValidityMs` is the total handoff validity and already includes
    // the six-minute Codex refresh guard exactly once.
    minimumValidityMs: CODEX_CONSUMER_REFRESH_GUARD_MS,
  });
  return { controller, store, now, rotate };
}

describe("managed Codex subscription session controller", () => {
  it("publishes a freshly enrolled same-account session behind a new writer fence", async () => {
    const { controller } = harness();
    const initial = await controller.acquire();
    const enrolled = auth(NOW + 4 * 60 * 60_000, 9);

    await expect(controller.reseed(enrolled)).resolves.toMatchObject({
      version: initial.version + 1,
      tokenExpiresAt: NOW + 4 * 60 * 60_000,
    });
    const next = await controller.acquire();
    expect(next.version).toBe(initial.version + 1);
    expect(next.auth.tokens.access_token).toBe(enrolled.tokens.access_token);
    expect(next.auth.tokens.refresh_token).toBe(CONTROLLER_REFRESH_SENTINEL);
  });

  it("rejects device enrollment for a different ChatGPT account", async () => {
    const { controller } = harness();
    const foreign = auth(NOW + 4 * 60 * 60_000, 9);
    foreign.tokens.account_id = "different-account";

    await expect(controller.reseed(foreign)).rejects.toMatchObject({
      code: "source_rejected",
    });
  });

  it("linearizes N simultaneous startups and never distributes the real refresh state", async () => {
    const rotate = vi.fn<SessionRotator>(async (_current, context) => {
      await context.markEffect();
      return auth(NOW + 2 * 60 * 60_000, 2);
    });
    const { controller, store } = harness({
      bootstrap: auth(NOW - 1_000, 1),
      rotate,
    });
    const sessions = await Promise.all(Array.from({ length: 32 }, () => controller.acquire()));
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(new Set(sessions.map((session) => session.version))).toEqual(new Set([1]));
    expect(new Set(sessions.map((session) => session.auth.tokens.refresh_token))).toEqual(
      new Set([CONTROLLER_REFRESH_SENTINEL]),
    );
    expect(JSON.stringify(await store.readState())).not.toContain("managed-refresh");
  });

  it("performs one unauthorized rotation and all concurrent retries consume its next version", async () => {
    const rotate = vi.fn<SessionRotator>(async (_current, context) => {
      await context.markEffect();
      return auth(NOW + 2 * 60 * 60_000, 2);
    });
    const { controller } = harness({ rotate });
    const initial = await controller.acquire();
    const retries = await Promise.all(Array.from({ length: 12 }, () => controller.acquire({
      afterUnauthorizedVersion: initial.version,
    })));
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(retries.every((session) => session.version === 2)).toBe(true);
  });

  it("atomically withholds an unauthorized source version from a reader already loading it", async () => {
    class InterleavingStore extends MemorySessionStateStore {
      blockNextRead = false;
      readonly readEntered = deferred<void>();
      readonly releaseRead = deferred<void>();

      override async getSnapshot(key: string) {
        if (this.blockNextRead) {
          this.blockNextRead = false;
          this.readEntered.resolve();
          await this.releaseRead.promise;
        }
        return super.getSnapshot(key);
      }
    }
    const store = new InterleavingStore();
    const rotation = deferred<ChatgptSubscriptionAuth>();
    const { controller } = harness({
      store,
      rotate: async (_current, context) => {
        await context.markEffect();
        return rotation.promise;
      },
    });
    const initial = await controller.acquire();

    store.blockNextRead = true;
    let freshResolved = false;
    const freshAcquire = controller.acquire().then((session) => {
      freshResolved = true;
      return session;
    });
    await store.readEntered.promise;
    const unauthorized = controller.acquire({ afterUnauthorizedVersion: initial.version });
    await vi.waitFor(async () => {
      const state = (await store.readState()).value;
      expect(state?.rotationAttempt).toMatchObject({
        sourceVersion: initial.version,
        reason: "unauthorized",
        fence: state?.writer?.fence,
      });
    });
    expect(freshResolved).toBe(false);

    rotation.resolve(auth(NOW + 2 * 60 * 60_000, 2));
    expect((await unauthorized).version).toBe(2);
    store.releaseRead.resolve();
    expect((await freshAcquire).version).toBe(2);
  });

  it("never resubmits refresh state after an uncertain provider-side failure", async () => {
    const rotate = vi.fn<SessionRotator>(async (_current, context) => {
      await context.markEffect();
      throw new SubscriptionSessionError("refresh_token_reused");
    });
    const { controller } = harness({
      bootstrap: auth(NOW - 1_000, 1),
      rotate,
    });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => controller.acquire()));
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await expect(controller.acquire()).rejects.toMatchObject({ code: "rotation_uncertain" });
  });

  it("leaves a post-effect rotation uncertain when it cannot cover the requested validity window", async () => {
    const required = CODEX_CONSUMER_REFRESH_GUARD_MS + 60_000;
    const { controller } = harness({
      bootstrap: auth(NOW - 1_000, 1),
      rotate: async (_current, context) => {
        await context.markEffect();
        return auth(NOW + required - 1, 2);
      },
    });
    await expect(controller.acquire({ minimumValidityMs: required })).rejects.toMatchObject({
      code: "rotation_uncertain",
    });
  });

  it("accepts guard and exact-total boundaries but rejects guard minus one", async () => {
    const exactExecutionReserve = 15 * 60_000;
    const exactTotal = CODEX_CONSUMER_REFRESH_GUARD_MS + exactExecutionReserve;
    const guardHarness = harness({ bootstrap: auth(NOW + CODEX_CONSUMER_REFRESH_GUARD_MS, 1) });
    await expect(guardHarness.controller.acquire({
      minimumValidityMs: CODEX_CONSUMER_REFRESH_GUARD_MS - 1,
    })).rejects.toMatchObject({ code: "snapshot_stale" });
    await expect(guardHarness.controller.acquire({
      minimumValidityMs: CODEX_CONSUMER_REFRESH_GUARD_MS,
    })).resolves.toMatchObject({ version: 1, expiresAt: NOW + CODEX_CONSUMER_REFRESH_GUARD_MS });

    const totalHarness = harness({ bootstrap: auth(NOW + exactTotal, 1) });
    await expect(totalHarness.controller.acquire({ minimumValidityMs: exactTotal }))
      .resolves.toMatchObject({ version: 1, expiresAt: NOW + exactTotal });
    expect(totalHarness.rotate).not.toHaveBeenCalled();
  });

  it("clears a synchronous pre-effect failure and safely retries with a newer fence", async () => {
    let attempts = 0;
    const rotate = vi.fn<SessionRotator>(async (_current, context) => {
      attempts += 1;
      if (attempts === 1) throw new Error("spawn failed before provider write");
      await context.markEffect();
      return auth(NOW + 2 * 60 * 60_000, 2);
    });
    const { controller, store } = harness({ bootstrap: auth(NOW - 1, 1), rotate });

    await expect(controller.acquire()).rejects.toMatchObject({ code: "rotation_failed" });
    expect((await store.readState()).value?.rotationAttempt).toBeNull();
    await expect(controller.acquire()).resolves.toMatchObject({ version: 1, fence: 2 });
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it("never retries a generic process crash after the provider effect boundary", async () => {
    const rotate = vi.fn<SessionRotator>(async (_current, context) => {
      await context.markEffect();
      throw new Error("lost response after account/read write");
    });
    const { controller, store } = harness({ bootstrap: auth(NOW - 1, 1), rotate });

    await expect(controller.acquire()).rejects.toMatchObject({ code: "rotation_uncertain" });
    expect((await store.readState()).value?.rotationAttempt?.phase).toBe("effect");
    await expect(controller.acquire()).rejects.toMatchObject({ code: "rotation_uncertain" });
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("recovers an expired writer lease with a strictly newer fence", async () => {
    const { controller, store } = harness();
    store.unsafeReplaceState({
      schema: 1,
      revision: 9,
      fence: 9,
      writer: { id: "crashed-writer", fence: 9, expiresAt: NOW - 1 },
      snapshot: null,
    });
    const session = await controller.acquire();
    expect(session.fence).toBe(10);
    expect((await store.readState()).value?.writer).toBeNull();
  });

  it("prevents a lost writer from publishing after another controller owns the fence", async () => {
    let finishRotation!: (value: ChatgptSubscriptionAuth) => void;
    const rotating = new Promise<ChatgptSubscriptionAuth>((resolve) => { finishRotation = resolve; });
    const { controller, store } = harness({
      bootstrap: auth(NOW - 1_000, 1),
      rotate: async (_current, context) => {
        await context.markEffect();
        return rotating;
      },
      leaseMs: 60_000,
    });
    const pending = controller.acquire();
    let state = (await store.readState()).value;
    for (let attempt = 0; !state?.writer && attempt < 20; attempt++) {
      await Promise.resolve();
      state = (await store.readState()).value;
    }
    expect(state?.writer).not.toBeNull();
    store.unsafeReplaceState({
      ...state!,
      revision: state!.revision + 1,
      fence: state!.fence + 1,
      writer: { id: "recovery-writer", fence: state!.fence + 1, expiresAt: NOW + 60_000 },
    });
    finishRotation(auth(NOW + 2 * 60 * 60_000, 2));
    await expect(pending).rejects.toMatchObject({ code: "writer_fence_lost" });
    expect((await store.readState()).value?.writer?.id).toBe("recovery-writer");
  });

  it("leaves an already-loaded foreground consumer independent while renewal is in flight", async () => {
    let finishRotation!: (value: ChatgptSubscriptionAuth) => void;
    const rotating = new Promise<ChatgptSubscriptionAuth>((resolve) => { finishRotation = resolve; });
    const rotate = vi.fn<SessionRotator>(async (_current, context) => {
      await context.markEffect();
      return rotating;
    });
    const { controller } = harness({ rotate });
    const initial = await controller.acquire();
    const renewal = controller.acquire({ afterUnauthorizedVersion: initial.version });
    while (rotate.mock.calls.length === 0) await Promise.resolve();
    expect(initial.version).toBe(1);
    expect(initial.auth.tokens.refresh_token).toBe(CONTROLLER_REFRESH_SENTINEL);
    finishRotation(auth(NOW + 2 * 60 * 60_000, 2));
    expect((await renewal).version).toBe(2);
  });

  const invalidRotations: Array<[
    string,
    (current: ChatgptSubscriptionAuth) => ChatgptSubscriptionAuth,
  ]> = [
    ["only last_refresh changes", (current) => ({
      ...current,
      last_refresh: new Date(NOW + 1_000).toISOString(),
      tokens: { ...current.tokens },
    })],
    ["only identity-token formatting changes", (current) => ({
      ...current,
      tokens: { ...current.tokens, id_token: jwt(NOW + 3 * 60 * 60_000, "reformatted-identity") },
    })],
    ["the account changes", () => ({
      ...auth(NOW + 2 * 60 * 60_000, 2),
      tokens: { ...auth(NOW + 2 * 60 * 60_000, 2).tokens, account_id: "different-account" },
    })],
    ["the access expiry is unchanged", () => auth(NOW + 60 * 60_000, 2)],
    ["the access expiry moves backwards", () => auth(NOW + 30 * 60_000, 2)],
    ["the old one-time refresh token is reused", (current) => ({
      ...auth(NOW + 2 * 60 * 60_000, 2),
      tokens: {
        ...auth(NOW + 2 * 60 * 60_000, 2).tokens,
        refresh_token: current.tokens.refresh_token,
      },
    })],
  ];

  it.each(invalidRotations)("does not publish a forced rotation when %s", async (_label, mutate) => {
    const rotate = vi.fn<SessionRotator>(async (current, context) => {
      await context.markEffect();
      return mutate(current);
    });
    const { controller, store } = harness({ rotate });
    const initial = await controller.acquire();
    await expect(controller.acquire({ afterUnauthorizedVersion: initial.version })).rejects.toMatchObject({
      code: "rotation_uncertain",
    });
    expect((await store.readState()).value?.snapshot?.version).toBe(initial.version);
  });

  it("detects an old encrypted object replayed under the current pointer", async () => {
    class CapturingStore extends MemorySessionStateStore {
      readonly values = new Map<string, Uint8Array>();
      override async putSnapshotIfAbsent(key: string, value: Uint8Array) {
        const created = await super.putSnapshotIfAbsent(key, value);
        if (created) this.values.set(key, Uint8Array.from(value));
        return created;
      }
      override unsafeReplaceSnapshot(key: string, value: Uint8Array) {
        super.unsafeReplaceSnapshot(key, value);
        this.values.set(key, Uint8Array.from(value));
      }
    }
    const store = new CapturingStore();
    const { controller } = harness({ store });
    const first = await controller.acquire();
    const firstState = (await store.readState()).value!;
    await controller.acquire({ afterUnauthorizedVersion: first.version });
    const current = (await store.readState()).value!;
    store.unsafeReplaceSnapshot(
      current.snapshot!.objectKey,
      store.values.get(firstState.snapshot!.objectKey)!,
    );
    await expect(controller.acquire()).rejects.toMatchObject({ code: "snapshot_corrupt" });
  });

  it("seals snapshot material and emits only bounded operator signals", async () => {
    class CapturingStore extends MemorySessionStateStore {
      sealed = new Uint8Array();
      override async putSnapshotIfAbsent(key: string, value: Uint8Array) {
        this.sealed = Uint8Array.from(value);
        return super.putSnapshotIfAbsent(key, value);
      }
    }
    const store = new CapturingStore();
    const { controller } = harness({ store });
    await controller.acquire();
    expect(Buffer.from(store.sealed).toString("utf8")).not.toContain("managed-refresh-1");
    const signal = subscriptionOperatorSignal(new Error("managed-refresh-1 refresh_token_reused"));
    expect(signal).toContain("JARVIS_CODEX_SESSION_UNAVAILABLE");
    expect(signal).not.toContain("managed-refresh-1");
  });
});

describe("controller Codex rotator crash handling", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function crashingChild(
    update: ChatgptSubscriptionAuth | null,
    stderrText = "",
  ) {
    return (_command: string, _args: readonly string[], options: { cwd: string }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      let input = "";
      child.stdin.on("data", (data) => {
        input += data.toString();
        while (input.includes("\n")) {
          const newline = input.indexOf("\n");
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 1) {
            child.stdout.write(`${JSON.stringify({
              id: 1,
              result: {
                codexHome: options.cwd,
                platformFamily: "unix",
                platformOs: "linux",
                userAgent: "codex_cli_rs/0.144.5",
              },
            })}\n`);
          } else if (message.id === 2) {
            if (update) writeFileSync(join(options.cwd, "auth.json"), canonicalAuthJson(update), { mode: 0o600 });
            if (stderrText) child.stderr.write(stderrText);
            queueMicrotask(() => {
              child.stderr.end();
              child.stdout.end();
              child.emit("close", 137);
            });
          }
        }
      });
      return child;
    };
  }

  function refreshingAppServer(
    update: ChatgptSubscriptionAuth,
    capture: { args?: readonly string[]; env?: NodeJS.ProcessEnv; messages: Array<Record<string, unknown>> },
  ) {
    return (_command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      capture.args = args;
      capture.env = options.env;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let input = "";
      child.stdin.on("data", (data) => {
        input += data.toString();
        while (input.includes("\n")) {
          const newline = input.indexOf("\n");
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          capture.messages.push(message);
          if (message.id === 1) {
            child.stdout.write(`${JSON.stringify({
              id: 1,
              result: {
                codexHome: options.cwd,
                platformFamily: "unix",
                platformOs: "linux",
                userAgent: "codex_cli_rs/0.144.5",
              },
            })}\n`);
          } else if (message.id === 2) {
            writeFileSync(join(options.cwd, "auth.json"), canonicalAuthJson(update), { mode: 0o600 });
            child.stdout.write(`${JSON.stringify({
              id: 2,
              result: {
                account: { type: "chatgpt", email: null, planType: "plus" },
                requiresOpenaiAuth: true,
              },
            })}\n`);
          }
        }
      });
      child.kill = () => {
        queueMicrotask(() => child.emit("close", 0));
        return true;
      };
      return child;
    };
  }

  function scriptedAppServer(script: {
    initialize(codexHome: string): string[];
    account?(codexHome: string): string[];
    updateOnAccount?: ChatgptSubscriptionAuth;
    throwOnAccountWrite?: boolean;
  }) {
    return (_command: string, _args: readonly string[], options: { cwd: string }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      let closed = false;
      child.kill = () => {
        if (!closed) queueMicrotask(() => {
          if (closed) return;
          closed = true;
          child.emit("close", 0);
        });
        return true;
      };
      let input = "";
      child.stdin.on("data", (data) => {
        input += data.toString();
        while (input.includes("\n")) {
          const newline = input.indexOf("\n");
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 1) {
            for (const output of script.initialize(options.cwd)) child.stdout.write(`${output}\n`);
          } else if (message.id === 2) {
            if (script.updateOnAccount) {
              writeFileSync(join(options.cwd, "auth.json"), canonicalAuthJson(script.updateOnAccount), { mode: 0o600 });
            }
            for (const output of script.account?.(options.cwd) ?? []) child.stdout.write(`${output}\n`);
          }
        }
      });
      if (script.throwOnAccountWrite) {
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          if (String(chunk).includes('"method":"account/read"')) throw new Error("synchronous stdin failure");
          return (write as (...values: unknown[]) => boolean)(chunk, ...args);
        }) as typeof child.stdin.write;
      }
      return child;
    };
  }

  const initializeResult = (codexHome: string) => ({
    id: 1,
    result: {
      codexHome,
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "codex_cli_rs/0.144.5",
    },
  });
  const accountResult = {
    id: 2,
    result: {
      account: { type: "chatgpt", email: null, planType: "plus" },
      requiresOpenaiAuth: true,
    },
  };

  function effectCallbacks(events: string[] = []) {
    let effect = false;
    return {
      markEffect: async () => {
        if (effect) throw new Error("effect already marked");
        effect = true;
        events.push("effect");
      },
      clearUnwrittenEffect: async () => {
        if (!effect) throw new Error("effect was not marked");
        effect = false;
        events.push("clear");
      },
    };
  }

  it("forces managed refresh through account/read without starting a model turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-session-rotator-"));
    roots.push(root);
    const current = auth(NOW + 10 * 60_000, 1);
    const updated = auth(NOW + 60 * 60_000, 2);
    const capture: {
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
      messages: Array<Record<string, unknown>>;
    } = { messages: [] };
    const effectEvents: string[] = [];

    await expect(rotateManagedSessionWithCodex("/pinned/codex", current, {
      root,
      requiredUntil: NOW + 30 * 60_000,
      spawnProcess: refreshingAppServer(updated, capture) as never,
      ...effectCallbacks(effectEvents),
    })).resolves.toEqual(updated);
    expect(capture.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(capture.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
    expect(capture.messages[2]).toMatchObject({ params: { refreshToken: true } });
    expect(effectEvents).toEqual(["effect"]);
    expect(capture.env?.OPENAI_API_KEY).toBeUndefined();
    expect(capture.env?.CODEX_API_KEY).toBeUndefined();
    expect(capture.env?.VAULT_ACCESS_TOKEN).toBeUndefined();
    expect(capture.env?.XDG_CONFIG_HOME).toBe(join(String(capture.env?.CODEX_HOME), "xdg-config"));
    expect(capture.env?.XDG_CACHE_HOME).toBe(join(String(capture.env?.CODEX_HOME), "xdg-cache"));
  });

  it("recovers the persisted rotation after a lost response or trusted Codex process crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-session-rotator-"));
    roots.push(root);
    const current = auth(NOW + 10_000, 1);
    const updated = auth(NOW + 60 * 60_000, 2);
    const result = await rotateManagedSessionWithCodex("/pinned/codex", current, {
      root,
      requiredUntil: NOW + 30 * 60_000,
      spawnProcess: crashingChild(updated) as never,
      ...effectCallbacks(),
    });
    expect(result).toEqual(updated);
    expect(readdirSync(root)).toEqual([]);
  });

  it("never reads host XDG, registry, selector, legacy auth, or API-key values for the rotation child", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-session-rotator-"));
    roots.push(root);
    const blocked = new Set([
      "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "NPM_CONFIG_REGISTRY", "npm_config_registry",
      "NODE_OPTIONS", "NODE_PATH", "JARVIS_CODEX_SESSION_SOURCE", "CODEX_AUTH_JSON_B64",
      "CODEX_AUTH_JSON", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
    ]);
    const environment = new Proxy<Record<string, string | undefined>>({ PATH: process.env.PATH }, {
      get(target, property) {
        const name = String(property);
        if (blocked.has(name)) throw new Error(`blocked environment getter invoked: ${name}`);
        return target[name];
      },
    });
    const capture: { env?: NodeJS.ProcessEnv; messages: Array<Record<string, unknown>> } = { messages: [] };
    await expect(rotateManagedSessionWithCodex("/pinned/codex", auth(NOW + 10_000, 1), {
      root,
      requiredUntil: NOW + 30 * 60_000,
      environment,
      spawnProcess: refreshingAppServer(auth(NOW + 60 * 60_000, 2), capture) as never,
      ...effectCallbacks(),
    })).resolves.toMatchObject({ auth_mode: "chatgpt" });
    expect(capture.env?.XDG_CONFIG_HOME).toBe(join(String(capture.env?.CODEX_HOME), "xdg-config"));
    expect(capture.env?.XDG_CACHE_HOME).toBe(join(String(capture.env?.CODEX_HOME), "xdg-cache"));
  });

  it("classifies refresh-token reuse without echoing child output or tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-session-rotator-"));
    roots.push(root);
    const current = auth(NOW + 10_000, 1);
    let error: unknown;
    try {
      await rotateManagedSessionWithCodex("/pinned/codex", current, {
        root,
        spawnProcess: crashingChild(null, `refresh_token_reused ${current.tokens.refresh_token}`) as never,
        ...effectCallbacks(),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SubscriptionSessionError);
    expect((error as SubscriptionSessionError).code).toBe("refresh_token_reused");
    expect(String(error)).not.toContain(current.tokens.refresh_token);
  });

  it("clears the durable effect when account/read fails synchronously before bytes cross", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-session-rotator-"));
    roots.push(root);
    const events: string[] = [];
    await expect(rotateManagedSessionWithCodex("/pinned/codex", auth(NOW + 10_000, 1), {
      root,
      spawnProcess: scriptedAppServer({
        initialize: (home) => [JSON.stringify(initializeResult(home))],
        throwOnAccountWrite: true,
      }) as never,
      ...effectCallbacks(events),
    })).rejects.toMatchObject({ code: "rotation_failed" });
    expect(events).toEqual(["effect", "clear"]);
  });

  it.each([
    ["unknown notification", () => ({
      initialize: (home: string) => [JSON.stringify(initializeResult(home))],
      account: () => [
        JSON.stringify({ method: "unknown/notification", params: {} }),
        JSON.stringify(accountResult),
      ],
    })],
    ["malformed notification", () => ({
      initialize: (home: string) => [JSON.stringify(initializeResult(home))],
      account: () => [
        JSON.stringify({ method: "account/updated", params: { authMode: "apikey" } }),
        JSON.stringify(accountResult),
      ],
    })],
    ["duplicate notification", () => ({
      initialize: (home: string) => [JSON.stringify(initializeResult(home))],
      account: () => [
        JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } }),
        JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } }),
        JSON.stringify(accountResult),
      ],
    })],
    ["out-of-order response", () => ({
      initialize: () => [JSON.stringify(accountResult)],
      account: () => [],
    })],
    ["duplicate response", () => ({
      initialize: (home: string) => [JSON.stringify(initializeResult(home)), JSON.stringify(initializeResult(home))],
      account: () => [JSON.stringify(accountResult)],
    })],
    ["duplicate-key response", () => ({
      initialize: (home: string) => [`{"id":1,"id":1,"result":${JSON.stringify(initializeResult(home).result)}}`],
      account: () => [],
    })],
    ["oversized response", () => ({
      initialize: () => [JSON.stringify({ id: 1, result: { payload: "x".repeat(70 * 1_024) } })],
      account: () => [],
    })],
  ])("rejects %s from the rotation-only app-server protocol", async (_label, buildScript) => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-session-rotator-"));
    roots.push(root);
    const updated = auth(NOW + 60 * 60_000, 2);
    const script = buildScript();
    await expect(rotateManagedSessionWithCodex("/pinned/codex", auth(NOW + 10_000, 1), {
      root,
      requiredUntil: NOW + 30 * 60_000,
      spawnProcess: scriptedAppServer({ ...script, updateOnAccount: updated }) as never,
      ...effectCallbacks(),
    })).rejects.toMatchObject({ code: "rotation_failed" });
  });
});
