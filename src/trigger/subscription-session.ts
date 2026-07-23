import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { hasExactKeys, isJsonRecord, parseStrictJson } from "../lib/bounded-json";
import {
  canonicalAuthJson,
  consumerAuth,
  isUsableManagedSessionRotation,
  parseChatgptSubscriptionAuthText,
  subscriptionAccessTokenExpiresAt,
  subscriptionAuthDigest,
  type ChatgptSubscriptionAuth,
} from "./subscription-auth";
import {
  CODEX_CONSUMER_REFRESH_GUARD_MS,
  DEFAULT_SUBSCRIPTION_VALIDITY_MS,
} from "./subscription-validity";

export const SESSION_STATE_SCHEMA = 1 as const;
export const DEFAULT_SESSION_LEASE_MS = 45_000;
export const DEFAULT_SESSION_WAIT_MS = 120_000;
export const DEFAULT_MINIMUM_VALIDITY_MS = DEFAULT_SUBSCRIPTION_VALIDITY_MS;

export type SubscriptionSessionErrorCode =
  | "configuration_missing"
  | "source_rejected"
  | "credential_broker_unavailable"
  | "session_store_unavailable"
  | "snapshot_corrupt"
  | "snapshot_stale"
  | "writer_timeout"
  | "writer_fence_lost"
  | "rotation_uncertain"
  | "rotation_failed"
  | "refresh_token_reused";

function operatorAction(code: SubscriptionSessionErrorCode): string {
  if (code === "configuration_missing") {
    return "repair the trusted controller configuration; do not copy session state or add an API key";
  }
  if (code === "source_rejected") {
    return "set JARVIS_CODEX_SESSION_SOURCE=vault-broker on the trusted host; do not copy session state into workers";
  }
  if (code === "credential_broker_unavailable") {
    return "restore the controller R2 temporary-credential broker; do not add static R2 keys or an API key";
  }
  if (code === "session_store_unavailable") {
    return "restore the private controller session store; do not copy session state into workers";
  }
  return "re-enrol the controller-managed ChatGPT session; do not add an API key";
}

export class SubscriptionSessionError extends Error {
  readonly name = "SubscriptionSessionError";
  readonly operatorSignal: string;

  constructor(readonly code: SubscriptionSessionErrorCode) {
    super(`JARVIS_CODEX_SESSION_UNAVAILABLE[${code}]: ${operatorAction(code)}`);
    this.operatorSignal = this.message;
  }
}

export function subscriptionOperatorSignal(error: unknown): string {
  return error instanceof SubscriptionSessionError
    ? error.operatorSignal
    : new SubscriptionSessionError("rotation_failed").operatorSignal;
}

export type SessionSnapshotPointer = {
  version: number;
  objectKey: string;
  objectDigest: string;
  previousObjectDigest: string | null;
  tokenExpiresAt: number;
  committedAt: number;
  fence: number;
};

export type SessionWriter = {
  id: string;
  fence: number;
  expiresAt: number;
};

export type SessionRotationReason = "bootstrap_stale" | "expired" | "unauthorized";

export type SessionRotationAttempt = {
  sourceVersion: number;
  fence: number;
  startedAt: number;
  reason: SessionRotationReason;
  phase: "intent" | "effect";
};

export type SessionState = {
  schema: typeof SESSION_STATE_SCHEMA;
  revision: number;
  fence: number;
  writer: SessionWriter | null;
  snapshot: SessionSnapshotPointer | null;
  rotationAttempt?: SessionRotationAttempt | null;
};

export type VersionedSessionState = { value: SessionState | null; etag: string | null };

export interface SessionStateStore {
  readState(): Promise<VersionedSessionState>;
  compareExchangeState(expectedEtag: string | null, value: SessionState): Promise<{ ok: boolean; etag?: string }>;
  putSnapshotIfAbsent(key: string, value: Uint8Array): Promise<boolean>;
  getSnapshot(key: string): Promise<Uint8Array | null>;
}

type SessionSnapshotRecord = {
  schema: typeof SESSION_STATE_SCHEMA;
  version: number;
  previousObjectDigest: string | null;
  tokenExpiresAt: number;
  committedAt: number;
  fence: number;
  authDigest: string;
  authJson: string;
};

export interface SessionSnapshotCipher {
  seal(value: Uint8Array): Uint8Array;
  open(value: Uint8Array): Uint8Array;
}

export class AesGcmSessionSnapshotCipher implements SessionSnapshotCipher {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new SubscriptionSessionError("configuration_missing");
    this.key = Buffer.from(key);
  }

  seal(value: Uint8Array): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from("jarvis/codex-session/v1", "utf8"));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([Buffer.from([SESSION_STATE_SCHEMA]), nonce, cipher.getAuthTag(), encrypted]);
  }

  open(value: Uint8Array): Uint8Array {
    try {
      const bytes = Buffer.from(value);
      if (bytes.byteLength < 30 || bytes[0] !== SESSION_STATE_SCHEMA) throw new Error("invalid envelope");
      const nonce = bytes.subarray(1, 13);
      const tag = bytes.subarray(13, 29);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(Buffer.from("jarvis/codex-session/v1", "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
    } catch {
      throw new SubscriptionSessionError("snapshot_corrupt");
    }
  }
}

export type SessionRotator = (
  current: ChatgptSubscriptionAuth,
  context: {
    reason: SessionRotationReason;
    fence: number;
    requiredUntil: number;
    /** Persisted before the account/read request can enter Codex stdin. */
    markEffect(): Promise<void>;
    /** Used only when that write throws synchronously and no bytes crossed. */
    clearUnwrittenEffect(): Promise<void>;
  },
) => Promise<ChatgptSubscriptionAuth>;

export type SessionBootstrap = () => Promise<ChatgptSubscriptionAuth>;

export type AcquiredSubscriptionSession = {
  auth: ChatgptSubscriptionAuth;
  version: number;
  expiresAt: number;
  fence: number;
};

type Clock = { now(): number; sleep(ms: number): Promise<void> };

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function initialState(): SessionState {
  return { schema: SESSION_STATE_SCHEMA, revision: 1, fence: 0, writer: null, snapshot: null, rotationAttempt: null };
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateSessionState(state: SessionState): void {
  if (!isJsonRecord(state)
    || !hasExactKeys(state, ["schema", "revision", "fence", "writer", "snapshot"], ["rotationAttempt"])
    ||
    state.schema !== SESSION_STATE_SCHEMA
    || !Number.isSafeInteger(state.revision) || state.revision < 1
    || !Number.isSafeInteger(state.fence) || state.fence < 0
  ) throw new SubscriptionSessionError("snapshot_corrupt");
  if (state.writer && (!isJsonRecord(state.writer)
    || !hasExactKeys(state.writer, ["id", "fence", "expiresAt"])
    ||
    !state.writer.id || state.writer.fence !== state.fence
    || !Number.isSafeInteger(state.writer.expiresAt)
  )) throw new SubscriptionSessionError("snapshot_corrupt");
  if (state.rotationAttempt && (!isJsonRecord(state.rotationAttempt)
    || !hasExactKeys(state.rotationAttempt, ["sourceVersion", "fence", "startedAt", "reason", "phase"])
    ||
    !Number.isSafeInteger(state.rotationAttempt.sourceVersion) || state.rotationAttempt.sourceVersion < 0
    || !Number.isSafeInteger(state.rotationAttempt.fence) || state.rotationAttempt.fence < 1
    || !Number.isSafeInteger(state.rotationAttempt.startedAt)
    || !["bootstrap_stale", "expired", "unauthorized"].includes(state.rotationAttempt.reason)
    || !["intent", "effect"].includes(state.rotationAttempt.phase)
    || state.rotationAttempt.sourceVersion !== (state.snapshot?.version ?? 0)
  )) throw new SubscriptionSessionError("snapshot_corrupt");
  const pointer = state.snapshot;
  if (pointer && (!isJsonRecord(pointer)
    || !hasExactKeys(pointer, [
      "version", "objectKey", "objectDigest", "previousObjectDigest",
      "tokenExpiresAt", "committedAt", "fence",
    ])
    ||
    !Number.isSafeInteger(pointer.version) || pointer.version < 1
    || !pointer.objectKey.startsWith("managed-codex-session/snapshots/")
    || !validDigest(pointer.objectDigest)
    || (pointer.previousObjectDigest !== null && !validDigest(pointer.previousObjectDigest))
    || !Number.isSafeInteger(pointer.tokenExpiresAt)
    || !Number.isSafeInteger(pointer.committedAt)
    || !Number.isSafeInteger(pointer.fence) || pointer.fence < 1
  )) throw new SubscriptionSessionError("snapshot_corrupt");
}

function parseSnapshotRecord(value: Uint8Array): SessionSnapshotRecord {
  try {
    const parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(value));
    if (!isJsonRecord(parsed)
      || !hasExactKeys(parsed, [
        "schema", "version", "previousObjectDigest", "tokenExpiresAt",
        "committedAt", "fence", "authDigest", "authJson",
      ])
      || parsed.schema !== SESSION_STATE_SCHEMA
      || !Number.isSafeInteger(parsed.version) || !Number.isSafeInteger(parsed.tokenExpiresAt)
      || !Number.isSafeInteger(parsed.committedAt) || !Number.isSafeInteger(parsed.fence)
      || typeof parsed.authDigest !== "string" || typeof parsed.authJson !== "string"
      || (parsed.previousObjectDigest !== null && typeof parsed.previousObjectDigest !== "string")) {
      throw new Error("schema");
    }
    return parsed as SessionSnapshotRecord;
  } catch (error) {
    if (error instanceof SubscriptionSessionError) throw error;
    throw new SubscriptionSessionError("snapshot_corrupt");
  }
}

export class ManagedSubscriptionSessionController {
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private readonly waitMs: number;
  private readonly minimumValidityMs: number;
  private readonly writerId: () => string;

  constructor(private readonly options: {
    store: SessionStateStore;
    cipher: SessionSnapshotCipher;
    bootstrap: SessionBootstrap;
    rotate: SessionRotator;
    clock?: Clock;
    leaseMs?: number;
    waitMs?: number;
    minimumValidityMs?: number;
    writerId?: () => string;
  }) {
    this.clock = options.clock ?? systemClock;
    this.leaseMs = options.leaseMs ?? DEFAULT_SESSION_LEASE_MS;
    this.waitMs = options.waitMs ?? DEFAULT_SESSION_WAIT_MS;
    this.minimumValidityMs = options.minimumValidityMs ?? DEFAULT_MINIMUM_VALIDITY_MS;
    this.writerId = options.writerId ?? randomUUID;
  }

  async acquire(input: {
    minimumValidityMs?: number;
    afterUnauthorizedVersion?: number;
  } = {}): Promise<AcquiredSubscriptionSession> {
    const requestedValidity = input.minimumValidityMs ?? this.minimumValidityMs;
    if (!Number.isSafeInteger(requestedValidity)
      || requestedValidity < CODEX_CONSUMER_REFRESH_GUARD_MS
      || (input.afterUnauthorizedVersion !== undefined
        && (!Number.isSafeInteger(input.afterUnauthorizedVersion) || input.afterUnauthorizedVersion < 1))) {
      throw new SubscriptionSessionError("snapshot_stale");
    }
    const startedAt = this.clock.now();
    const requiredUntil = () => this.clock.now() + requestedValidity;
    while (this.clock.now() - startedAt <= this.waitMs) {
      const observed = await this.ensureState();
      const pointer = observed.value.snapshot;
      const sourceVersion = pointer?.version ?? 0;
      const attempted = observed.value.rotationAttempt;
      if (attempted?.sourceVersion === sourceVersion) {
        const activeWriter = observed.value.writer;
        const writerActive = Boolean(activeWriter
          && activeWriter.expiresAt > this.clock.now()
          && activeWriter.fence === attempted.fence);
        if (!writerActive && attempted.phase === "intent") {
          // No provider request crossed while this intent's writer was live;
          // clear it by CAS so a newer fenced writer can safely take over.
          await this.clearAbandonedIntent(observed);
          continue;
        }
        if (!writerActive) {
          // The provider may have consumed the source refresh token before the
          // writer disappeared. Recovery must never replay it.
          throw new SubscriptionSessionError("rotation_uncertain");
        }
        const remaining = Math.max(1, activeWriter!.expiresAt - this.clock.now());
        await this.clock.sleep(Math.min(100, remaining));
        continue;
      }
      const supersedesUnauthorized = input.afterUnauthorizedVersion === undefined
        || sourceVersion > input.afterUnauthorizedVersion;
      if (pointer && supersedesUnauthorized && pointer.tokenExpiresAt >= requiredUntil()) {
        const loaded = await this.loadCurrent(observed);
        if (loaded) return loaded;
        continue;
      }

      const unauthorized = input.afterUnauthorizedVersion !== undefined
        && sourceVersion <= input.afterUnauthorizedVersion;
      const lease = await this.tryAcquireWriter(observed, unauthorized ? "unauthorized" : undefined);
      if (lease) {
        await this.writeFreshSnapshot(lease, {
          unauthorized,
          requiredUntil: requiredUntil(),
        });
        continue;
      }

      // A current snapshot meeting the caller's validity window returned
      // above even if a background writer exists. A merely non-expired but
      // stale snapshot is never issued to a new process.
      const remaining = observed.value.writer
        ? Math.max(1, observed.value.writer.expiresAt - this.clock.now())
        : 25;
      await this.clock.sleep(Math.min(100, remaining));
    }
    throw new SubscriptionSessionError("writer_timeout");
  }

  private async ensureState(): Promise<{ value: SessionState; etag: string }> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.options.store.readState();
      if (current.value && current.etag) {
        validateSessionState(current.value);
        return { value: current.value, etag: current.etag };
      }
      const created = initialState();
      const result = await this.options.store.compareExchangeState(null, created);
      if (result.ok && result.etag) return { value: created, etag: result.etag };
    }
    throw new SubscriptionSessionError("writer_timeout");
  }

  private async tryAcquireWriter(
    observed: { value: SessionState; etag: string },
    rotationIntent?: "unauthorized",
  ): Promise<{ writer: SessionWriter; state: SessionState; etag: string } | null> {
    const now = this.clock.now();
    if (observed.value.writer && observed.value.writer.expiresAt > now) return null;
    const fence = observed.value.fence + 1;
    const writer = { id: this.writerId(), fence, expiresAt: now + this.leaseMs };
    const next: SessionState = {
      ...observed.value,
      revision: observed.value.revision + 1,
      fence,
      writer,
      ...(rotationIntent ? {
        // Linearize the unauthorized intent with writer acquisition. A fresh
        // reader can no longer load the rejected source version in the gap
        // before the provider request starts.
          rotationAttempt: {
            sourceVersion: observed.value.snapshot?.version ?? 0,
            fence,
            startedAt: now,
            reason: rotationIntent,
            phase: "intent",
        },
      } : {}),
    };
    const result = await this.options.store.compareExchangeState(observed.etag, next);
    return result.ok && result.etag ? { writer, state: next, etag: result.etag } : null;
  }

  private async writeFreshSnapshot(
    lease: { writer: SessionWriter; state: SessionState; etag: string },
    request: { unauthorized: boolean; requiredUntil: number },
  ): Promise<void> {
    let heartbeatChain = Promise.resolve();
    let fenceLive = true;
    const renew = async () => {
      const current = await this.options.store.readState();
      if (!current.value || !current.etag || current.value.writer?.id !== lease.writer.id
        || current.value.writer.fence !== lease.writer.fence) {
        fenceLive = false;
        return;
      }
      const next: SessionState = {
        ...current.value,
        revision: current.value.revision + 1,
        writer: { ...current.value.writer, expiresAt: this.clock.now() + this.leaseMs },
      };
      const result = await this.options.store.compareExchangeState(current.etag, next);
      if (result.ok) {
        fenceLive = true;
      } else {
        const latest = await this.options.store.readState();
        fenceLive = latest.value?.writer?.id === lease.writer.id
          && latest.value.writer.fence === lease.writer.fence;
      }
    };
    const heartbeat = setInterval(() => {
      heartbeatChain = heartbeatChain.then(renew).catch(() => { fenceLive = false; });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();

    try {
      let currentAuth: ChatgptSubscriptionAuth;
      const currentPointer = lease.state.snapshot;
      if (currentPointer) {
        currentAuth = await this.loadSnapshot(currentPointer);
      } else {
        try {
          currentAuth = await this.options.bootstrap();
          subscriptionAccessTokenExpiresAt(currentAuth);
        } catch {
          throw new SubscriptionSessionError("configuration_missing");
        }
      }

      const expiresAt = subscriptionAccessTokenExpiresAt(currentAuth);
      const reason: SessionRotationReason | null = request.unauthorized
        ? "unauthorized"
        : expiresAt < request.requiredUntil
          ? currentPointer ? "expired" : "bootstrap_stale"
          : null;
      let nextAuth = currentAuth;
      if (reason) {
        await this.markRotationAttempt(lease.writer, reason, currentPointer?.version ?? 0);
        try {
          nextAuth = await this.options.rotate(currentAuth, {
            reason,
            fence: lease.writer.fence,
            requiredUntil: request.requiredUntil,
            markEffect: () => this.markRotationEffect(lease.writer),
            clearUnwrittenEffect: () => this.revertUnwrittenRotationEffect(lease.writer),
          });
        } catch (error) {
          const phase = await this.rotationPhase(lease.writer);
          if (phase === "intent") await this.clearRotationIntent(lease.writer);
          if (phase === "effect"
            && !(error instanceof SubscriptionSessionError
              && ["refresh_token_reused", "writer_fence_lost"].includes(error.code))) {
            throw new SubscriptionSessionError("rotation_uncertain");
          }
          if (error instanceof SubscriptionSessionError) throw error;
          throw new SubscriptionSessionError("rotation_failed");
        }
      }
      const nextExpiry = subscriptionAccessTokenExpiresAt(nextAuth);
      if (reason) {
        const phase = await this.rotationPhase(lease.writer);
        if (phase !== "effect") {
          if (phase === "intent") await this.clearRotationIntent(lease.writer);
          throw new SubscriptionSessionError("rotation_failed");
        }
        if (nextExpiry < request.requiredUntil
          || !isUsableManagedSessionRotation(currentAuth, nextAuth, request.requiredUntil)) {
          // The request crossed Codex. An unchanged or malformed reread cannot
          // prove whether the one-time refresh state was consumed.
          throw new SubscriptionSessionError("rotation_uncertain");
        }
      } else if (nextExpiry < request.requiredUntil) {
        throw new SubscriptionSessionError("snapshot_stale");
      }

      clearInterval(heartbeat);
      await heartbeatChain;
      if (!fenceLive) throw new SubscriptionSessionError("writer_fence_lost");
      await this.commitSnapshot(lease.writer, nextAuth);
    } finally {
      clearInterval(heartbeat);
      await heartbeatChain.catch(() => undefined);
      await this.releaseWriter(lease.writer).catch(() => undefined);
    }
  }

  private async commitSnapshot(writer: SessionWriter, auth: ChatgptSubscriptionAuth): Promise<void> {
    const current = await this.options.store.readState();
    if (!current.value || !current.etag || current.value.writer?.id !== writer.id
      || current.value.writer.fence !== writer.fence || current.value.writer.expiresAt <= this.clock.now()) {
      throw new SubscriptionSessionError("writer_fence_lost");
    }
    const prior = current.value.snapshot;
    const version = (prior?.version ?? 0) + 1;
    const tokenExpiresAt = subscriptionAccessTokenExpiresAt(auth);
    const committedAt = this.clock.now();
    const record: SessionSnapshotRecord = {
      schema: SESSION_STATE_SCHEMA,
      version,
      previousObjectDigest: prior?.objectDigest ?? null,
      tokenExpiresAt,
      committedAt,
      fence: writer.fence,
      authDigest: subscriptionAuthDigest(auth),
      authJson: canonicalAuthJson(auth),
    };
    const sealed = this.options.cipher.seal(Buffer.from(JSON.stringify(record), "utf8"));
    const objectDigest = sha256(sealed);
    const objectKey = `managed-codex-session/snapshots/${String(version).padStart(12, "0")}-${objectDigest}.sealed`;
    if (!await this.options.store.putSnapshotIfAbsent(objectKey, sealed)) {
      const existing = await this.options.store.getSnapshot(objectKey);
      if (!existing || sha256(existing) !== objectDigest) throw new SubscriptionSessionError("snapshot_corrupt");
    }
    const pointer: SessionSnapshotPointer = {
      version,
      objectKey,
      objectDigest,
      previousObjectDigest: prior?.objectDigest ?? null,
      tokenExpiresAt,
      committedAt,
      fence: writer.fence,
    };
    const next: SessionState = {
      ...current.value,
      revision: current.value.revision + 1,
      writer: null,
      snapshot: pointer,
      rotationAttempt: null,
    };
    const result = await this.options.store.compareExchangeState(current.etag, next);
    if (!result.ok) throw new SubscriptionSessionError("writer_fence_lost");
  }

  private async markRotationAttempt(
    writer: SessionWriter,
    reason: SessionRotationReason,
    sourceVersion: number,
  ): Promise<void> {
    const current = await this.options.store.readState();
    if (!current.value || !current.etag || current.value.writer?.id !== writer.id
      || current.value.writer.fence !== writer.fence || current.value.writer.expiresAt <= this.clock.now()) {
      throw new SubscriptionSessionError("writer_fence_lost");
    }
    const existing = current.value.rotationAttempt;
    if (existing?.sourceVersion === sourceVersion
      && existing.fence === writer.fence
      && existing.reason === reason) {
      return;
    }
    if (existing?.sourceVersion === sourceVersion) {
      throw new SubscriptionSessionError("rotation_uncertain");
    }
    const result = await this.options.store.compareExchangeState(current.etag, {
      ...current.value,
      revision: current.value.revision + 1,
      rotationAttempt: { sourceVersion, fence: writer.fence, startedAt: this.clock.now(), reason, phase: "intent" },
    });
    if (!result.ok) throw new SubscriptionSessionError("writer_fence_lost");
  }

  private async markRotationEffect(writer: SessionWriter): Promise<void> {
    const current = await this.options.store.readState();
    const attempt = current.value?.rotationAttempt;
    if (!current.value || !current.etag || current.value.writer?.id !== writer.id
      || current.value.writer.fence !== writer.fence || current.value.writer.expiresAt <= this.clock.now()
      || !attempt || attempt.fence !== writer.fence || attempt.phase !== "intent") {
      throw new SubscriptionSessionError("writer_fence_lost");
    }
    const result = await this.options.store.compareExchangeState(current.etag, {
      ...current.value,
      revision: current.value.revision + 1,
      rotationAttempt: { ...attempt, phase: "effect" },
    });
    if (!result.ok) throw new SubscriptionSessionError("writer_fence_lost");
  }

  private async revertUnwrittenRotationEffect(writer: SessionWriter): Promise<void> {
    const current = await this.options.store.readState();
    const attempt = current.value?.rotationAttempt;
    if (!current.value || !current.etag || current.value.writer?.id !== writer.id
      || current.value.writer.fence !== writer.fence || !attempt
      || attempt.fence !== writer.fence || attempt.phase !== "effect") {
      throw new SubscriptionSessionError("writer_fence_lost");
    }
    const result = await this.options.store.compareExchangeState(current.etag, {
      ...current.value,
      revision: current.value.revision + 1,
      rotationAttempt: { ...attempt, phase: "intent" },
    });
    if (!result.ok) throw new SubscriptionSessionError("writer_fence_lost");
  }

  private async rotationPhase(writer: SessionWriter): Promise<"intent" | "effect" | null> {
    const current = await this.options.store.readState();
    const attempt = current.value?.rotationAttempt;
    return attempt?.fence === writer.fence ? attempt.phase : null;
  }

  private async clearRotationIntent(writer: SessionWriter): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.options.store.readState();
      const rotation = current.value?.rotationAttempt;
      if (!current.value || !current.etag || current.value.writer?.id !== writer.id
        || current.value.writer.fence !== writer.fence || !rotation
        || rotation.fence !== writer.fence || rotation.phase !== "intent") return;
      const result = await this.options.store.compareExchangeState(current.etag, {
        ...current.value,
        revision: current.value.revision + 1,
        rotationAttempt: null,
      });
      if (result.ok) return;
    }
    throw new SubscriptionSessionError("writer_fence_lost");
  }

  private async clearAbandonedIntent(observed: { value: SessionState; etag: string }): Promise<void> {
    const attempt = observed.value.rotationAttempt;
    if (!attempt || attempt.phase !== "intent") return;
    const writer = observed.value.writer;
    if (writer && writer.fence === attempt.fence && writer.expiresAt > this.clock.now()) return;
    await this.options.store.compareExchangeState(observed.etag, {
      ...observed.value,
      revision: observed.value.revision + 1,
      writer: writer?.fence === attempt.fence ? null : writer,
      rotationAttempt: null,
    });
  }

  private async releaseWriter(writer: SessionWriter): Promise<void> {
    const current = await this.options.store.readState();
    if (!current.value || !current.etag || current.value.writer?.id !== writer.id
      || current.value.writer.fence !== writer.fence) return;
    await this.options.store.compareExchangeState(current.etag, {
      ...current.value,
      revision: current.value.revision + 1,
      writer: null,
    });
  }

  private async loadCurrent(
    observed: { value: SessionState; etag: string },
  ): Promise<AcquiredSubscriptionSession | null> {
    const pointer = observed.value.snapshot;
    if (!pointer) return null;
    const auth = await this.loadSnapshot(pointer);
    const after = await this.options.store.readState();
    if (!after.value || after.value.snapshot?.objectDigest !== pointer.objectDigest
      || after.value.snapshot.version !== pointer.version
      || after.value.rotationAttempt?.sourceVersion === pointer.version) return null;
    return {
      auth: consumerAuth(auth),
      version: pointer.version,
      expiresAt: pointer.tokenExpiresAt,
      fence: pointer.fence,
    };
  }

  private async loadSnapshot(pointer: SessionSnapshotPointer): Promise<ChatgptSubscriptionAuth> {
    const sealed = await this.options.store.getSnapshot(pointer.objectKey);
    if (!sealed || sha256(sealed) !== pointer.objectDigest) throw new SubscriptionSessionError("snapshot_corrupt");
    const record = parseSnapshotRecord(this.options.cipher.open(sealed));
    if (
      record.version !== pointer.version
      || record.previousObjectDigest !== pointer.previousObjectDigest
      || record.tokenExpiresAt !== pointer.tokenExpiresAt
      || record.committedAt !== pointer.committedAt
      || record.fence !== pointer.fence
    ) throw new SubscriptionSessionError("snapshot_corrupt");
    let auth: ChatgptSubscriptionAuth;
    try {
      auth = parseChatgptSubscriptionAuthText(record.authJson);
    } catch {
      throw new SubscriptionSessionError("snapshot_corrupt");
    }
    if (subscriptionAuthDigest(auth) !== record.authDigest
      || subscriptionAccessTokenExpiresAt(auth) !== record.tokenExpiresAt) {
      throw new SubscriptionSessionError("snapshot_corrupt");
    }
    return auth;
  }
}

/** Strongly consistent fake used by the non-billable concurrent harness. */
export class MemorySessionStateStore implements SessionStateStore {
  private state: SessionState | null = null;
  private etag: string | null = null;
  private revision = 0;
  private readonly snapshots = new Map<string, Uint8Array>();

  async readState(): Promise<VersionedSessionState> {
    return {
      value: this.state ? structuredClone(this.state) : null,
      etag: this.etag,
    };
  }

  async compareExchangeState(expectedEtag: string | null, value: SessionState): Promise<{ ok: boolean; etag?: string }> {
    if (expectedEtag !== this.etag) return { ok: false };
    this.revision += 1;
    this.etag = `memory-${this.revision}`;
    this.state = structuredClone(value);
    return { ok: true, etag: this.etag };
  }

  async putSnapshotIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
    if (this.snapshots.has(key)) return false;
    this.snapshots.set(key, Uint8Array.from(value));
    return true;
  }

  async getSnapshot(key: string): Promise<Uint8Array | null> {
    const value = this.snapshots.get(key);
    return value ? Uint8Array.from(value) : null;
  }

  // Test/harness fault injection never exists on the production R2 adapter.
  unsafeReplaceState(value: SessionState): void {
    this.revision += 1;
    this.etag = `memory-${this.revision}`;
    this.state = structuredClone(value);
  }

  unsafeReplaceSnapshot(key: string, value: Uint8Array): void {
    this.snapshots.set(key, Uint8Array.from(value));
  }
}
