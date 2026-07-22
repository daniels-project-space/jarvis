import type { CodexTurnResult } from "./codex-app-server";
import {
  FOREGROUND_SESSION_RENEWAL_RESERVE_MS,
  FOREGROUND_TURN_VALIDITY_RESERVE_MS,
} from "./foreground-policy";
import {
  isCodexUnauthorizedError,
  type PreparedSubscriptionEnv,
} from "./subscription-runtime";
import {
  SubscriptionSessionError,
  subscriptionOperatorSignal,
} from "./subscription-session";

export type ForegroundSessionServer = {
  start(): Promise<void>;
  stop(): void;
};

type ReadyForegroundSession<Server extends ForegroundSessionServer> = {
  prepared: PreparedSubscriptionEnv & {
    snapshotVersion: number;
    snapshotExpiresAt: number;
  };
  server: Server;
};

type RenewalReason = "proactive" | "admission" | "unauthorized";

export type ForegroundSessionOwnerOptions<Server extends ForegroundSessionServer> = {
  initial: PreparedSubscriptionEnv;
  scope: string;
  createServer(env: NodeJS.ProcessEnv): Server;
  prepare(input: {
    scope: string;
    minimumValidityMs: number;
    afterUnauthorizedVersion: number;
  }): Promise<PreparedSubscriptionEnv>;
  preflight(env: NodeJS.ProcessEnv): string | undefined;
  cleanup(env: NodeJS.ProcessEnv): boolean | void;
  onRenewalError?(signal: string): void;
  onRenewalReady?(): void;
  now?: () => number;
  retryDelayMs?: number;
};

function verifiedForegroundSnapshot(
  prepared: PreparedSubscriptionEnv,
): ReadyForegroundSession<ForegroundSessionServer>["prepared"] {
  if (prepared.error) throw new Error(prepared.error);
  if (!Number.isSafeInteger(prepared.snapshotVersion) || Number(prepared.snapshotVersion) < 1
    || !Number.isSafeInteger(prepared.snapshotExpiresAt)) {
    throw new SubscriptionSessionError("snapshot_stale");
  }
  return prepared as ReadyForegroundSession<ForegroundSessionServer>["prepared"];
}

export function foregroundSessionOperatorSignal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const safe = message.match(/JARVIS_CODEX_SESSION_UNAVAILABLE\[[a-z_]+\]:[^\r\n]{1,400}/)?.[0];
  return safe ?? subscriptionOperatorSignal(error);
}

/**
 * Owns one serving foreground app-server and at most one hot replacement.
 * A candidate is preflighted and initialized before the pointer changes; an
 * active turn pins its server until completion, so rotation cannot interrupt
 * or silently replay work that Codex already accepted.
 */
export class ForegroundSessionOwner<Server extends ForegroundSessionServer> {
  private current: ReadyForegroundSession<Server>;
  private activeTurns = 0;
  private pendingCandidate: {
    session: ReadyForegroundSession<Server>;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  private buildingCandidate: ReadyForegroundSession<Server> | null = null;
  private renewal: Promise<void> | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private readonly cleanedEnvs = new Set<NodeJS.ProcessEnv>();
  private readonly cleanupRetries = new Set<NodeJS.ProcessEnv>();
  private readonly stoppedServers = new Set<Server>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: ForegroundSessionOwnerOptions<Server>) {
    const initial = verifiedForegroundSnapshot(options.initial);
    this.current = { prepared: initial, server: options.createServer(initial.env) };
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? 15_000);
  }

  get snapshotVersion(): number {
    return this.current.prepared.snapshotVersion;
  }

  get snapshotExpiresAt(): number {
    return this.current.prepared.snapshotExpiresAt;
  }

  canAdmitTurn(at = this.now()): boolean {
    return this.snapshotExpiresAt - at >= FOREGROUND_TURN_VALIDITY_RESERVE_MS;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Codex foreground session owner is closed");
    if (!this.startPromise) {
      const initial = this.current;
      this.startPromise = initial.server.start().then(() => {
        if (!this.closed && this.current === initial) this.scheduleRenewal();
      });
    }
    await this.startPromise;
  }

  /** Execute one turn, replaying only a pre-start 401 and only once. */
  async runTurn(
    execute: (server: Server, onStarted: () => void) => Promise<CodexTurnResult>,
  ): Promise<CodexTurnResult> {
    let replayedUnauthorized = false;
    while (true) {
      const admitted = await this.beginTurn();
      let started = false;
      let result: CodexTurnResult;
      try {
        result = await execute(admitted.server, () => { started = true; });
      } catch (error) {
        this.endTurn();
        if (!isCodexUnauthorizedError(error)) throw error;
        if (started) {
          await this.renewAfter(admitted.version, "unauthorized");
          throw error;
        }
        if (replayedUnauthorized) throw error;
        await this.renewAfter(admitted.version, "unauthorized");
        replayedUnauthorized = true;
        continue;
      }
      this.endTurn();
      if (result.code !== 0 && isCodexUnauthorizedError(result.stderr)) {
        if (!started && !replayedUnauthorized) {
          await this.renewAfter(admitted.version, "unauthorized");
          replayedUnauthorized = true;
          continue;
        }
        if (started) await this.renewAfter(admitted.version, "unauthorized");
      }
      return result;
    }
  }

  /** Public for deterministic admission and timer/401 single-flight tests. */
  async renewForUnauthorized(version = this.snapshotVersion): Promise<void> {
    await this.renewAfter(version, "unauthorized");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearRenewalTimer();
    const closed = new Error("Codex foreground session owner closed during replacement");
    if (this.pendingCandidate) {
      const pending = this.pendingCandidate;
      this.pendingCandidate = null;
      this.safeStop(pending.session.server);
      this.safeCleanup(pending.session.prepared.env);
      pending.reject(closed);
    }
    if (this.buildingCandidate) {
      this.safeStop(this.buildingCandidate.server);
      this.safeCleanup(this.buildingCandidate.prepared.env);
      this.buildingCandidate = null;
    }
    this.safeStop(this.current.server);
    this.safeCleanup(this.current.prepared.env);
    for (const env of [...this.cleanupRetries]) this.safeCleanup(env);
    // Acquisition itself owns no local consumer home. If it finishes after
    // close, buildCandidate observes `closed` and immediately cleans the home
    // before creating or publishing another serving process.
    void this.renewal?.catch(() => undefined);
  }

  private async beginTurn(): Promise<{ server: Server; version: number }> {
    if (this.closed) throw new Error("Codex foreground session owner is closed");
    await this.start();
    if (!this.canAdmitTurn()) await this.renewAfter(this.snapshotVersion, "admission");
    if (!this.canAdmitTurn()) throw new SubscriptionSessionError("snapshot_stale");
    if (this.pendingCandidate && this.activeTurns === 0) this.commitCandidate();
    this.activeTurns += 1;
    return { server: this.current.server, version: this.current.prepared.snapshotVersion };
  }

  private endTurn(): void {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    if (this.activeTurns === 0 && this.pendingCandidate) this.commitCandidate();
  }

  private renewAfter(version: number, reason: RenewalReason): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex foreground session owner is closed"));
    if (this.snapshotVersion > version) return Promise.resolve();
    if (this.renewal) return this.renewal.then(() => {
      if (this.snapshotVersion <= version) throw new SubscriptionSessionError("snapshot_stale");
    });

    const work = this.buildCandidate(version, reason);
    this.renewal = work;
    void work.then(
      () => { if (this.renewal === work) this.renewal = null; },
      () => { if (this.renewal === work) this.renewal = null; },
    );
    return work;
  }

  private async buildCandidate(version: number, reason: RenewalReason): Promise<void> {
    let candidate: ReadyForegroundSession<Server> | null = null;
    try {
      const prepared = await this.options.prepare({
        scope: `${this.options.scope}-${reason}`,
        minimumValidityMs: FOREGROUND_SESSION_RENEWAL_RESERVE_MS,
        afterUnauthorizedVersion: version,
      });
      if (this.closed) {
        this.safeCleanup(prepared.env);
        throw new Error("Codex foreground session owner closed during acquisition");
      }
      if (prepared.error) {
        this.safeCleanup(prepared.env);
        throw new Error(prepared.error);
      }
      if (Number(prepared.snapshotVersion) <= version) {
        this.safeCleanup(prepared.env);
        throw new SubscriptionSessionError("snapshot_stale");
      }
      const preflightError = this.options.preflight(prepared.env);
      if (preflightError) {
        this.safeCleanup(prepared.env);
        throw new Error(preflightError);
      }
      const verified = verifiedForegroundSnapshot(prepared);
      candidate = { prepared: verified, server: this.options.createServer(verified.env) };
      this.buildingCandidate = candidate;
      await candidate.server.start();
      if (this.closed) throw new Error("Codex foreground session owner closed during readiness attestation");
      if (candidate.prepared.snapshotExpiresAt - this.now() < FOREGROUND_TURN_VALIDITY_RESERVE_MS) {
        throw new SubscriptionSessionError("snapshot_stale");
      }
      this.buildingCandidate = null;
      if (this.current.prepared.snapshotVersion > version) {
        this.safeStop(candidate.server);
        this.safeCleanup(candidate.prepared.env);
        return;
      }
      if (this.activeTurns === 0) {
        this.swap(candidate);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        this.pendingCandidate = { session: candidate!, resolve, reject };
      });
    } catch (error) {
      if (candidate) {
        if (this.buildingCandidate === candidate) this.buildingCandidate = null;
        if (this.pendingCandidate?.session === candidate) this.pendingCandidate = null;
        this.safeStop(candidate.server);
        this.safeCleanup(candidate.prepared.env);
      }
      throw new Error(foregroundSessionOperatorSignal(error));
    }
  }

  private commitCandidate(): void {
    const pending = this.pendingCandidate;
    if (!pending || this.activeTurns !== 0) return;
    this.pendingCandidate = null;
    if (this.closed) {
      this.safeStop(pending.session.server);
      this.safeCleanup(pending.session.prepared.env);
      pending.reject(new Error("Codex foreground session owner closed before replacement"));
      return;
    }
    this.swap(pending.session);
    pending.resolve();
  }

  private swap(candidate: ReadyForegroundSession<Server>): void {
    const previous = this.current;
    // Publish the already-ready candidate first. Only then retire the idle old
    // process, leaving no interval in which the owner points at a dead server.
    this.current = candidate;
    this.scheduleRenewal();
    this.options.onRenewalReady?.();
    this.safeStop(previous.server);
    this.safeCleanup(previous.prepared.env);
  }

  private scheduleRenewal(delayMs?: number): void {
    if (this.closed) return;
    this.clearRenewalTimer();
    const delay = delayMs ?? Math.max(
      0,
      this.snapshotExpiresAt - this.now() - FOREGROUND_SESSION_RENEWAL_RESERVE_MS,
    );
    const version = this.snapshotVersion;
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = null;
      void this.renewAfter(version, "proactive").catch((error) => {
        this.options.onRenewalError?.(foregroundSessionOperatorSignal(error));
        if (!this.closed && this.snapshotVersion === version) this.scheduleRenewal(this.retryDelayMs);
      });
    }, delay);
    this.renewalTimer.unref?.();
  }

  private clearRenewalTimer(): void {
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalTimer = null;
  }

  private safeStop(server: Server): void {
    if (this.stoppedServers.has(server)) return;
    this.stoppedServers.add(server);
    try { server.stop(); } catch { /* best-effort process retirement */ }
  }

  private safeCleanup(env: NodeJS.ProcessEnv): void {
    if (this.cleanedEnvs.has(env)) return;
    try {
      if (this.options.cleanup(env) === false) {
        this.cleanupRetries.add(env);
        return;
      }
      this.cleanupRetries.delete(env);
      this.cleanedEnvs.add(env);
    } catch {
      this.cleanupRetries.add(env);
    }
  }
}
