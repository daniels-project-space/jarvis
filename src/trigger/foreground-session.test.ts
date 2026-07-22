import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FOREGROUND_SESSION_RENEWAL_RESERVE_MS,
  FOREGROUND_TURN_VALIDITY_RESERVE_MS,
} from "./foreground-policy";
import {
  ForegroundSessionOwner,
  type ForegroundSessionServer,
} from "./foreground-session";
import type { PreparedSubscriptionEnv } from "./subscription-runtime";

const HOUR = 60 * 60_000;
const START = Date.UTC(2026, 6, 22, 12);

function prepared(version: number, expiresAt: number): PreparedSubscriptionEnv {
  return {
    env: {
      NODE_ENV: "test",
      CODEX_HOME: `/owned/session-${version}`,
      SNAPSHOT_VERSION: String(version),
    },
    snapshotVersion: version,
    snapshotExpiresAt: expiresAt,
    snapshotFence: version,
  };
}

type FakeServer = ForegroundSessionServer & {
  version: number;
  running: boolean;
  starts: number;
  stops: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("foreground subscription hot-swap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(options: {
    initialExpiresAt?: number;
    prepare?: (input: {
      scope: string;
      minimumValidityMs: number;
      afterUnauthorizedVersion: number;
    }) => Promise<PreparedSubscriptionEnv>;
    failStartVersion?: number;
    onRenewalError?: (signal: string) => void;
  } = {}) {
    const events: string[] = [];
    const servers = new Map<number, FakeServer>();
    const cleaned: string[] = [];
    const state: { owner?: ForegroundSessionOwner<FakeServer> } = {};
    let nextVersion = 2;
    const acquire = vi.fn(options.prepare ?? (async () => prepared(nextVersion++, Date.now() + HOUR)));
    const createServer = vi.fn((env: NodeJS.ProcessEnv): FakeServer => {
      const version = Number(env.SNAPSHOT_VERSION);
      const server: FakeServer = {
        version,
        running: false,
        starts: 0,
        stops: 0,
        async start() {
          server.starts += 1;
          events.push(`start:${version}`);
          if (version === options.failStartVersion) throw new Error("candidate readiness failed");
          server.running = true;
        },
        stop() {
          server.stops += 1;
          events.push(`stop:${version}:current:${state.owner!.snapshotVersion}`);
          if (version === 1 && servers.has(2)) {
            events.push(`candidate-running:${String(servers.get(2)!.running)}`);
          }
          server.running = false;
        },
      };
      servers.set(version, server);
      return server;
    });
    const owner = new ForegroundSessionOwner({
      initial: prepared(1, options.initialExpiresAt ?? START + HOUR),
      scope: "foreground-test",
      createServer,
      prepare: acquire,
      preflight: () => undefined,
      cleanup: (env) => { cleaned.push(String(env.CODEX_HOME)); },
      onRenewalError: options.onRenewalError,
      now: () => Date.now(),
      retryDelayMs: 10_000,
    });
    state.owner = owner;
    return { owner, acquire, createServer, servers, cleaned, events };
  }

  it("never admits a turn whose full validity window crosses snapshot expiry", async () => {
    const operatorSignal = "JARVIS_CODEX_SESSION_UNAVAILABLE[snapshot_stale]: renew the managed session";
    const h = harness({
      initialExpiresAt: START + FOREGROUND_TURN_VALIDITY_RESERVE_MS - 1,
      prepare: async () => ({ env: { NODE_ENV: "test" }, error: operatorSignal }),
    });
    const execute = vi.fn();

    await expect(h.owner.runTurn(execute)).rejects.toThrow(operatorSignal);
    expect(execute).not.toHaveBeenCalled();
    expect(h.owner.snapshotVersion).toBe(1);
    await h.owner.close();
  });

  it("publishes a ready candidate before stopping the old server with no dead interval", async () => {
    const h = harness({
      initialExpiresAt: START + FOREGROUND_SESSION_RENEWAL_RESERVE_MS + 1_000,
    });
    await h.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.owner.snapshotVersion).toBe(2);
    expect(h.events).toEqual([
      "start:1",
      "start:2",
      "stop:1:current:2",
      "candidate-running:true",
    ]);
    expect(h.servers.get(2)?.running).toBe(true);
    await h.owner.close();
  });

  it("keeps the current server serving when candidate readiness fails", async () => {
    const h = harness({ failStartVersion: 2 });
    await h.owner.start();

    await expect(h.owner.renewForUnauthorized()).rejects.toThrow("rotation_failed");
    expect(h.owner.snapshotVersion).toBe(1);
    expect(h.servers.get(1)?.running).toBe(true);
    expect(h.servers.get(1)?.stops).toBe(0);
    expect(h.cleaned).toContain("/owned/session-2");

    const result = await h.owner.runTurn(async (server, onStarted) => {
      expect(server.version).toBe(1);
      onStarted();
      return { finalText: "still available", threadId: "thread", code: 0, stderr: "" };
    });
    expect(result.finalText).toBe("still available");
    await h.owner.close();
  });

  it("emits a bounded operator signal without leaking a failed acquisition detail", async () => {
    const onRenewalError = vi.fn();
    const h = harness({
      initialExpiresAt: START + FOREGROUND_SESSION_RENEWAL_RESERVE_MS + 1_000,
      prepare: async () => { throw new Error("refresh-secret-must-not-escape"); },
      onRenewalError,
    });
    await h.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onRenewalError).toHaveBeenCalledTimes(1);
    expect(onRenewalError.mock.calls[0][0]).toContain("JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_failed]");
    expect(onRenewalError.mock.calls[0][0]).not.toContain("refresh-secret-must-not-escape");
    expect(h.owner.snapshotVersion).toBe(1);
    await h.owner.close();
  });

  it("coalesces a timer and 401 into one candidate acquisition", async () => {
    const acquisition = deferred<PreparedSubscriptionEnv>();
    const h = harness({
      initialExpiresAt: START + FOREGROUND_SESSION_RENEWAL_RESERVE_MS + 1_000,
      prepare: () => acquisition.promise,
    });
    await h.owner.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.acquire).toHaveBeenCalledTimes(1);

    const unauthorized = h.owner.renewForUnauthorized(1);
    acquisition.resolve(prepared(2, START + HOUR));
    await unauthorized;

    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.createServer).toHaveBeenCalledTimes(2);
    expect(h.owner.snapshotVersion).toBe(2);
    await h.owner.close();
  });

  it("waits for a successful active turn before swapping and never replays it", async () => {
    const turn = deferred<{ finalText: string; threadId: string; code: number; stderr: string }>();
    const h = harness({
      initialExpiresAt: START + FOREGROUND_SESSION_RENEWAL_RESERVE_MS + 1_000,
    });
    await h.owner.start();
    const execute = vi.fn(async (_server: FakeServer, onStarted: () => void) => {
      onStarted();
      return turn.promise;
    });
    const running = h.owner.runTurn(execute);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.owner.snapshotVersion).toBe(1);
    expect(h.servers.get(1)?.running).toBe(true);
    expect(h.servers.get(2)?.running).toBe(true);
    expect(h.servers.get(1)?.stops).toBe(0);

    turn.resolve({ finalText: "delivered", threadId: "thread", code: 0, stderr: "" });
    await expect(running).resolves.toMatchObject({ finalText: "delivered" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.owner.snapshotVersion).toBe(2);
    expect(h.servers.get(1)?.stops).toBe(1);
    await h.owner.close();
  });

  it("replays one pre-start 401 only after the candidate is ready", async () => {
    const h = harness();
    await h.owner.start();
    const execute = vi.fn(async (server: FakeServer, onStarted: () => void) => {
      if (server.version === 1) throw new Error("401 unauthorized");
      onStarted();
      return { finalText: "recovered", threadId: "thread", code: 0, stderr: "" };
    });

    await expect(h.owner.runTurn(execute)).resolves.toMatchObject({ finalText: "recovered" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(h.events.indexOf("start:2")).toBeLessThan(h.events.indexOf("stop:1:current:2"));
    expect(h.events).toContain("candidate-running:true");
    await h.owner.close();
  });

  it("repairs but never replays an unauthorized turn that already started", async () => {
    const h = harness();
    await h.owner.start();
    const execute = vi.fn(async (_server: FakeServer, onStarted: () => void) => {
      onStarted();
      throw new Error("401 unauthorized after turn/start");
    });

    await expect(h.owner.runTurn(execute)).rejects.toThrow("401 unauthorized after turn/start");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.owner.snapshotVersion).toBe(2);
    await h.owner.close();
  });

  it("renews throughout a four-hour owner lifetime without a first failed normal turn or leaked home", async () => {
    const h = harness();
    await h.owner.start();
    const execute = vi.fn(async (server: FakeServer, onStarted: () => void) => {
      expect(server.running).toBe(true);
      onStarted();
      return { finalText: `ok-${server.version}`, threadId: "thread", code: 0, stderr: "" };
    });

    for (let hour = 1; hour <= 4; hour += 1) {
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(h.owner.canAdmitTurn()).toBe(true);
      await expect(h.owner.runTurn(execute)).resolves.toMatchObject({ code: 0 });
    }

    expect(execute).toHaveBeenCalledTimes(4);
    expect(h.owner.snapshotVersion).toBeGreaterThanOrEqual(5);
    await h.owner.close();
    expect(new Set(h.cleaned).size).toBe(h.servers.size);
    expect(h.cleaned).toHaveLength(h.servers.size);
  });
});
