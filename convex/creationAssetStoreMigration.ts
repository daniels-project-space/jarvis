import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import {
  CREATION_ASSET_STORE_V1,
  CREATION_ASSET_STORE_V2,
  creationAssetLocatorForMigration,
  creationAssetLocatorFromRow,
} from "./creationAssetLocator";
import { actorAuthArgs, requireActor, requireAdmin, requireWorker } from "./controlAuth";

// One intentionally named migration. It is additive and retained as audit
// evidence after cutover; starting it is the durable freeze point, not a
// best-effort task enqueue.
export const CREATION_ASSET_STORE_MIGRATION_KEY = "private-creation-r2-v2";
const SNAPSHOT_PAGE_SIZE = 12;
const CUTOVER_PAGE_SIZE = 12;
const COPY_LEASE_MS = 10 * 60_000;
const MAX_ASSET_BYTES = 30 * 1024 * 1024;
const CAPABILITY_PROOF_TTL_MS = 15 * 60_000;

type MigrationState = "snapshotting" | "frozen" | "cutover_ready" | "cutting_over" | "cutover" | "activated" | "aborted" | "failed";
type ItemState = "pending" | "copying" | "verified" | "cutover" | "failed";
type CapabilityRuntime = "vercel" | "trigger";

function cleanCapabilityRuntime(value: string): CapabilityRuntime {
  if (value === "vercel" || value === "trigger") return value;
  throw migrationFailure("V2 capability proof runtime is invalid");
}

async function requireCapabilityProofActor(
  ctx: any,
  args: { authTokenHash?: string; workerToken?: string },
  runtime: CapabilityRuntime,
): Promise<void> {
  // The two durable proof records intentionally have different authorities:
  // only the owner/Vercel control path may verify Vercel, while only Trigger's
  // worker capability may verify Trigger. A route cannot claim both runtimes.
  if (runtime === "vercel") {
    await requireAdmin(ctx, args.authTokenHash);
    return;
  }
  requireWorker(args.workerToken);
}

function migrationFailure(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "CREATION_ASSET_MIGRATION_FAILED", message });
}

async function migration(ctx: { db: any }) {
  return await ctx.db
    .query("creationAssetStoreMigrations")
    .withIndex("by_key", (q: any) => q.eq("key", CREATION_ASSET_STORE_MIGRATION_KEY))
    .first();
}

function migrationAttempt(row: any): number {
  return Math.max(1, Math.floor(Number(row?.attempt ?? 1)));
}

async function itemForCreation(ctx: { db: any }, attempt: number, creationId: any) {
  return await ctx.db
    .query("creationAssetStoreMigrationItems")
    .withIndex("by_migration_attempt_creation", (q: any) => q
      .eq("migrationKey", CREATION_ASSET_STORE_MIGRATION_KEY)
      .eq("attempt", attempt)
      .eq("creationId", creationId))
    .first();
}

async function capabilityProof(ctx: { db: any }, runtime: CapabilityRuntime) {
  return await ctx.db
    .query("creationAssetStoreCapabilityProofs")
    .withIndex("by_migration_runtime", (q: any) => q.eq("migrationKey", CREATION_ASSET_STORE_MIGRATION_KEY).eq("runtime", runtime))
    .first();
}

function cleanFailureReason(value: string | undefined, fallback: string): string {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240) || fallback;
}

function proofSummary(row: any) {
  return {
    state: typeof row?.state === "string" ? row.state : "missing",
    attempt: Number(row?.attempt ?? 0),
    expiresAt: Number(row?.expiresAt ?? 0),
    verifiedAt: row?.verifiedAt,
  };
}

function proofIsCurrent(row: any, attempt: number, now: number): boolean {
  return Boolean(
    row
    && row.state === "verified"
    && Number(row.attempt) === attempt
    && Number(row.expiresAt) > now,
  );
}

async function currentPreflight(ctx: { db: any }, now: number) {
  const [vercel, trigger] = await Promise.all([
    capabilityProof(ctx, "vercel"),
    capabilityProof(ctx, "trigger"),
  ]);
  const attempt = Math.max(1, Math.floor(Math.max(Number(vercel?.attempt ?? 0), Number(trigger?.attempt ?? 0), 1)));
  return { vercel, trigger, attempt, ready: proofIsCurrent(vercel, attempt, now) && proofIsCurrent(trigger, attempt, now) };
}

function cleanSha256(value: string): string {
  const sha256 = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("migration copy digest is invalid");
  return sha256;
}

function cleanContentType(value: string | undefined): string {
  const contentType = value?.trim().toLowerCase() || "application/octet-stream";
  if (contentType.length > 160 || /[\u0000-\u001f\u007f]/.test(contentType)) {
    throw new Error("migration content type is invalid");
  }
  return contentType;
}

function currentDestination(item: any) {
  const generation = Number(item?.destinationGeneration);
  if (
    item?.destinationStore !== CREATION_ASSET_STORE_V2
    || typeof item?.destinationLocator !== "string"
    || !Number.isSafeInteger(generation)
    || generation < 1
    || generation > 999_999_999
  ) return null;
  try {
    const destination = creationAssetLocatorForMigration(
      String(item.creationId),
      migrationAttempt(item),
      generation,
    );
    return destination.assetLocator === item.destinationLocator ? destination : null;
  } catch {
    return null;
  }
}

function verifiedDestination(item: any) {
  const destination = currentDestination(item);
  return destination
    && Number(item?.verifiedDestinationGeneration) === Number(item?.destinationGeneration)
    && item?.verifiedDestinationLocator === destination.assetLocator
    ? destination
    : null;
}

function nextDestinationGeneration(item: any): number | null {
  const current = item?.destinationGeneration === undefined ? 0 : Number(item.destinationGeneration);
  if (!Number.isSafeInteger(current) || current < 0 || current >= 999_999_999) return null;
  return current + 1;
}

function liveTicket(item: any, ticket: any, now: number): boolean {
  const destination = currentDestination(item);
  return Boolean(
    destination
    && ticket
    && ticket.state === "active"
    && ticket.purpose === "copy"
    && ticket.migrationKey === CREATION_ASSET_STORE_MIGRATION_KEY
    && Number(ticket.attempt ?? 1) === Number(item.attempt ?? 1)
    && String(ticket.itemId) === String(item._id)
    && String(ticket.creationId) === String(item.creationId)
    && ticket.destinationStore === destination.assetStore
    && ticket.destinationLocator === destination.assetLocator
    && Number(ticket.destinationGeneration) === Number(item.destinationGeneration)
    && ticket.expiresAt > now
    && String(item.activeTicketId ?? "") === String(ticket._id)
    && item.state === "copying"
    && Number(item.claimExpiresAt ?? 0) > now,
  );
}

function stateSummary(row: any) {
  return {
    state: row.state,
    attempt: migrationAttempt(row),
    snapshotComplete: Boolean(row.snapshotComplete),
    expectedCount: Number(row.expectedCount),
    verifiedCount: Number(row.verifiedCount),
    cutoverCount: Number(row.cutoverCount),
    freezeAt: Number(row.freezeAt),
    cutoverAt: row.cutoverAt,
    activatedAt: row.activatedAt,
    abortedAt: row.abortedAt,
    activeStore: row.state === "activated" ? CREATION_ASSET_STORE_V2 : undefined,
    failure: row.failure,
  };
}

// This mutation starts only after both Vercel and Trigger have independently
// persisted an isolated V2 write/readback/delete capability proof. Its insert
// is the freeze/CAS anchor: creations:create and creations:remove inspect this
// row before they mutate a private asset.
export const start = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const existing = await migration(ctx);
    const now = Date.now();
    // Replays against an already persisted migration are not a new start or a
    // new freeze. Only the insert/restart path below can transition V1 into a
    // frozen state, and that path requires the paired proof.
    if (existing && existing.state !== "aborted") return stateSummary(existing);
    const preflight = await currentPreflight(ctx, now);
    // An abort is a new operational attempt, not permission to reuse an old
    // V2 capability assertion. Require a newer pair before it can freeze V1
    // again, even if the prior proof record has not reached its TTL yet.
    const requiredProofAttempt = existing ? migrationAttempt(existing) + 1 : 1;
    if (!preflight.ready || preflight.attempt < requiredProofAttempt) {
      throw migrationFailure("Vercel and Trigger V2 capability proofs are required before freezing V1");
    }
    const attempt = existing ? migrationAttempt(existing) + 1 : 1;
    if (existing) {
      // Old manifests remain as immutable audit records under their previous
      // attempt. The new attempt gets a fresh cursor/snapshot after V1 was
      // deliberately unfrozen by abort.
      await ctx.db.patch(existing._id, {
        state: "snapshotting" satisfies MigrationState,
        attempt,
        snapshotCursor: undefined,
        snapshotComplete: false,
        expectedCount: 0,
        verifiedCount: 0,
        cutoverCount: 0,
        freezeAt: now,
        cutoverAt: undefined,
        activatedAt: undefined,
        abortedAt: undefined,
        abortReason: undefined,
        failure: undefined,
        updatedAt: now,
      });
      const restarted = await migration(ctx);
      if (!restarted) throw migrationFailure("creation asset migration state disappeared");
      return stateSummary(restarted);
    }
    await ctx.db.insert("creationAssetStoreMigrations", {
      key: CREATION_ASSET_STORE_MIGRATION_KEY,
      state: "snapshotting" satisfies MigrationState,
      attempt,
      snapshotComplete: false,
      expectedCount: 0,
      verifiedCount: 0,
      cutoverCount: 0,
      freezeAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const created = await migration(ctx);
    if (!created) throw migrationFailure("creation asset migration state was not persisted");
    return stateSummary(created);
  },
});

// Preflight itself never freezes V1. It creates/reuses a bounded pair of
// proof records; Vercel executes its proof synchronously and dispatches the
// Trigger proof task with only this opaque record id.
export const beginPreflight = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const existingMigration = await migration(ctx);
    if (existingMigration && existingMigration.state !== "aborted") {
      return { ready: false as const, migration: stateSummary(existingMigration) };
    }
    const now = Date.now();
    const [existingVercel, existingTrigger] = await Promise.all([
      capabilityProof(ctx, "vercel"),
      capabilityProof(ctx, "trigger"),
    ]);
    const previousAttempt = Math.max(Number(existingVercel?.attempt ?? 0), Number(existingTrigger?.attempt ?? 0), 0);
    const currentAttempt = Math.max(1, Math.floor(previousAttempt || 1));
    const currentReady = proofIsCurrent(existingVercel, currentAttempt, now) && proofIsCurrent(existingTrigger, currentAttempt, now);
    const currentPending = Boolean(
      existingVercel && existingTrigger
      && Number(existingVercel.attempt) === currentAttempt
      && Number(existingTrigger.attempt) === currentAttempt
      && Number(existingVercel.expiresAt) > now
      && Number(existingTrigger.expiresAt) > now
      && (existingVercel.state === "pending" || existingVercel.state === "verified")
      && (existingTrigger.state === "pending" || existingTrigger.state === "verified"),
    );
    // A pre-cutover abort deliberately requires a new cross-runtime proof for
    // the next freeze. Once that newer proof pair exists it is reused through
    // its bounded TTL, rather than being reset by every polling request.
    const restarting = existingMigration?.state === "aborted";
    const requiredRestartProofAttempt = restarting ? migrationAttempt(existingMigration) + 1 : 1;
    const hasRestartProofAttempt = !restarting || currentAttempt >= requiredRestartProofAttempt;
    if (hasRestartProofAttempt && (currentReady || currentPending)) {
      return {
        ready: currentReady,
        vercel: { proofId: String(existingVercel!._id), ...proofSummary(existingVercel) },
        trigger: { proofId: String(existingTrigger!._id), ...proofSummary(existingTrigger) },
      };
    }
    const attempt = Math.max(
      currentAttempt + (existingVercel || existingTrigger ? 1 : 0),
      requiredRestartProofAttempt,
    );
    const expiresAt = now + CAPABILITY_PROOF_TTL_MS;
    const reset = {
      attempt,
      state: "pending",
      expiresAt,
      verifiedAt: undefined,
      sha256: undefined,
      sizeBytes: undefined,
      failure: undefined,
      updatedAt: now,
    };
    const vercelId = existingVercel
      ? (await ctx.db.patch(existingVercel._id, reset), existingVercel._id)
      : await ctx.db.insert("creationAssetStoreCapabilityProofs", {
        migrationKey: CREATION_ASSET_STORE_MIGRATION_KEY,
        runtime: "vercel",
        ...reset,
        createdAt: now,
      });
    const triggerId = existingTrigger
      ? (await ctx.db.patch(existingTrigger._id, reset), existingTrigger._id)
      : await ctx.db.insert("creationAssetStoreCapabilityProofs", {
        migrationKey: CREATION_ASSET_STORE_MIGRATION_KEY,
        runtime: "trigger",
        ...reset,
        createdAt: now,
      });
    return {
      ready: false as const,
      vercel: { proofId: String(vercelId), state: "pending", attempt, expiresAt },
      trigger: { proofId: String(triggerId), state: "pending", attempt, expiresAt },
    };
  },
});

export const claimCapabilityProof = mutation({
  args: { proofId: v.id("creationAssetStoreCapabilityProofs"), runtime: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    const runtime = cleanCapabilityRuntime(args.runtime);
    await requireCapabilityProofActor(ctx, args, runtime);
    const proof: any = await ctx.db.get(args.proofId);
    if (!proof || proof.migrationKey !== CREATION_ASSET_STORE_MIGRATION_KEY || proof.runtime !== runtime) {
      return { ready: false as const, missing: true as const };
    }
    if (proof.state !== "pending" || Number(proof.expiresAt) <= Date.now()) {
      return { ready: false as const, inactive: true as const };
    }
    // Deliberately return only the opaque id/attempt. The V2 probe locator is
    // derived inside the server-only storage primitive, not in Trigger input.
    return { ready: true as const, proofId: String(proof._id), attempt: Number(proof.attempt) };
  },
});

export const verifyCapabilityProof = mutation({
  args: {
    proofId: v.id("creationAssetStoreCapabilityProofs"),
    runtime: v.string(),
    attempt: v.number(),
    sha256: v.string(),
    sizeBytes: v.number(),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    const runtime = cleanCapabilityRuntime(args.runtime);
    await requireCapabilityProofActor(ctx, args, runtime);
    const proof: any = await ctx.db.get(args.proofId);
    const now = Date.now();
    if (
      !proof
      || proof.migrationKey !== CREATION_ASSET_STORE_MIGRATION_KEY
      || proof.runtime !== runtime
      || proof.state !== "pending"
      || Number(proof.attempt) !== Math.floor(args.attempt)
      || Number(proof.expiresAt) <= now
    ) throw migrationFailure("V2 capability proof is no longer current");
    const sha256 = cleanSha256(args.sha256);
    if (!Number.isSafeInteger(args.sizeBytes) || args.sizeBytes < 1 || args.sizeBytes > 4 * 1024) {
      throw migrationFailure("V2 capability proof size is invalid");
    }
    await ctx.db.patch(proof._id, {
      state: "verified",
      sha256,
      sizeBytes: args.sizeBytes,
      verifiedAt: now,
      updatedAt: now,
    });
    return proofSummary({ ...proof, state: "verified", sha256, sizeBytes: args.sizeBytes, verifiedAt: now });
  },
});

export const failCapabilityProof = mutation({
  args: {
    proofId: v.id("creationAssetStoreCapabilityProofs"),
    runtime: v.string(),
    attempt: v.number(),
    reason: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    const runtime = cleanCapabilityRuntime(args.runtime);
    await requireCapabilityProofActor(ctx, args, runtime);
    const proof: any = await ctx.db.get(args.proofId);
    if (
      !proof
      || proof.migrationKey !== CREATION_ASSET_STORE_MIGRATION_KEY
      || proof.runtime !== runtime
      || proof.state !== "pending"
      || Number(proof.attempt) !== Math.floor(args.attempt)
    ) return false;
    await ctx.db.patch(proof._id, {
      state: "failed",
      failure: cleanFailureReason(args.reason, "V2 capability proof failed"),
      updatedAt: Date.now(),
    });
    return true;
  },
});

// Abort is an explicit pre-cutover recovery door. It never rolls V2 metadata
// back: once even one row has crossed stores, the migration stays fail-closed.
// Before that point, the durable aborted state unfreezes V1 and keeps the old
// manifest/tickets as audit evidence; a later proven start uses a new attempt.
export const abort = mutation({
  args: { reason: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const state = await migration(ctx);
    if (!state) return null;
    if (state.state === "aborted") return stateSummary(state);
    if (
      Number(state.cutoverCount) > 0
      || state.state === "cutting_over"
      || state.state === "cutover"
      || state.state === "activated"
    ) {
      throw migrationFailure("a migration with cutover work cannot be unfrozen or aborted");
    }
    const now = Date.now();
    await ctx.db.patch(state._id, {
      state: "aborted" satisfies MigrationState,
      abortedAt: now,
      abortReason: cleanFailureReason(args.reason, "owner aborted migration before cutover"),
      updatedAt: now,
    });
    const aborted = await migration(ctx);
    if (!aborted) throw migrationFailure("creation asset migration state disappeared");
    return stateSummary(aborted);
  },
});

// One bounded page per mutation. We paginate the immutable asset identity,
// not updatedAt: ordinary title/data edits may continue while private asset
// identities are frozen, and must not move a V1 row across the snapshot
// cursor. Retries insert the same unique (migration, creation) entry or
// advance the same durable cursor.
export const snapshotStep = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const state = await migration(ctx);
    if (!state) throw migrationFailure("creation asset migration has not been started");
    if (state.state !== "snapshotting") return stateSummary(state);
    const attempt = migrationAttempt(state);

    const page = await ctx.db
      .query("creations")
      .withIndex("by_assetR2Key")
      .order("asc")
      .paginate({
        cursor: state.snapshotCursor ?? null,
        numItems: SNAPSHOT_PAGE_SIZE,
        maximumRowsRead: SNAPSHOT_PAGE_SIZE,
      });
    const now = Date.now();
    let added = 0;
    for (const creation of page.page) {
      const source = creationAssetLocatorFromRow(creation);
      if (!source || source.assetStore !== CREATION_ASSET_STORE_V1) continue;
      const existing = await itemForCreation(ctx, attempt, creation._id);
      if (existing) continue;
      await ctx.db.insert("creationAssetStoreMigrationItems", {
        migrationKey: CREATION_ASSET_STORE_MIGRATION_KEY,
        attempt,
        creationId: creation._id,
        sourceStore: source.assetStore,
        sourceLocator: source.assetLocator,
        // A destination is not chosen at snapshot time. Every worker claim
        // receives a fresh immutable generation so a late object-store PUT
        // from an expired lease cannot overwrite a later retry's target.
        destinationStore: CREATION_ASSET_STORE_V2,
        sourceContentType: typeof creation.assetContentType === "string" ? creation.assetContentType.slice(0, 160) : undefined,
        state: "pending" satisfies ItemState,
        createdAt: now,
        updatedAt: now,
      });
      added += 1;
    }
    const snapshotComplete = Boolean(page.isDone);
    const expectedCount = Number(state.expectedCount) + added;
    await ctx.db.patch(state._id, {
      snapshotCursor: page.continueCursor,
      snapshotComplete,
      expectedCount,
      state: snapshotComplete ? (expectedCount === 0 ? "cutover_ready" : "frozen") satisfies MigrationState : "snapshotting" satisfies MigrationState,
      updatedAt: now,
    });
    const updated = await migration(ctx);
    if (!updated) throw migrationFailure("creation asset migration state disappeared");
    return stateSummary(updated);
  },
});

// The task scheduler receives these opaque IDs only. It cannot choose a
// source key, destination key, or store; it must obtain a short-lived
// server-issued copy ticket below.
export const pendingCreationIds = query({
  args: { limit: v.optional(v.number()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const state = await migration(ctx);
    if (!state || (state.state !== "frozen" && state.state !== "cutover_ready")) return [];
    const attempt = migrationAttempt(state);
    const limit = Math.min(12, Math.max(1, Math.floor(args.limit ?? 4)));
    const pending = await ctx.db
      .query("creationAssetStoreMigrationItems")
      .withIndex("by_migration_attempt_state", (q: any) => q
        .eq("migrationKey", CREATION_ASSET_STORE_MIGRATION_KEY)
        .eq("attempt", attempt)
        .eq("state", "pending"))
      .take(limit);
    return pending.map((item: any) => ({ creationId: String(item.creationId) }));
  },
});

export const claimCopy = mutation({
  args: { creationId: v.id("creations"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const state = await migration(ctx);
    if (!state || (state.state !== "frozen" && state.state !== "cutover_ready")) return { ready: false as const, inactive: true as const };
    const attempt = migrationAttempt(state);
    const item = await itemForCreation(ctx, attempt, args.creationId);
    if (!item) return { ready: false as const, missing: true as const };
    const now = Date.now();
    if (item.state === "verified" || item.state === "cutover") return { ready: false as const, complete: true as const };
    if (item.state === "copying" && Number(item.claimExpiresAt ?? 0) > now) {
      return { ready: false as const, retryAfterMs: Number(item.claimExpiresAt) - now };
    }
    const creation = await ctx.db.get(args.creationId);
    const canonical = creation ? creationAssetLocatorFromRow(creation) : null;
    if (
      !canonical
      || canonical.assetStore !== item.sourceStore
      || canonical.assetLocator !== item.sourceLocator
      || item.sourceStore !== CREATION_ASSET_STORE_V1
      || item.destinationStore !== CREATION_ASSET_STORE_V2
    ) {
      await ctx.db.patch(state._id, {
        state: "failed" satisfies MigrationState,
        failure: "A frozen migration source no longer matches its durable snapshot",
        updatedAt: now,
      });
      // Do not throw after this patch: Convex rolls a mutation back on throw,
      // which would erase the durable failed state and make a later retry look
      // safe. The failed discriminator stops tasks without reopening V1.
      return { ready: false as const, failed: true as const };
    }
    const generation = nextDestinationGeneration(item);
    if (!generation) {
      await ctx.db.patch(state._id, {
        state: "failed" satisfies MigrationState,
        failure: "Migration copy generation is invalid; refusing a shared V2 destination retry",
        updatedAt: now,
      });
      return { ready: false as const, failed: true as const };
    }
    let destination;
    try {
      destination = creationAssetLocatorForMigration(String(item.creationId), attempt, generation);
    } catch {
      await ctx.db.patch(state._id, {
        state: "failed" satisfies MigrationState,
        failure: "Migration copy destination generation could not be derived",
        updatedAt: now,
      });
      return { ready: false as const, failed: true as const };
    }
    const previousTicket: any = item.activeTicketId ? await ctx.db.get(item.activeTicketId) : null;
    if (previousTicket?.state === "active") {
      await ctx.db.patch(previousTicket._id, { state: "revoked", consumedAt: now });
    }
    const ticketId = await ctx.db.insert("creationAssetStoreMigrationTickets", {
      migrationKey: CREATION_ASSET_STORE_MIGRATION_KEY,
      attempt,
      itemId: item._id,
      creationId: item.creationId,
      purpose: "copy",
      destinationStore: destination.assetStore,
      destinationLocator: destination.assetLocator,
      destinationGeneration: generation,
      state: "active",
      expiresAt: now + COPY_LEASE_MS,
      createdAt: now,
    });
    await ctx.db.patch(item._id, {
      state: "copying" satisfies ItemState,
      activeTicketId: ticketId,
      claimExpiresAt: now + COPY_LEASE_MS,
      destinationLocator: destination.assetLocator,
      destinationGeneration: generation,
      verifiedDestinationLocator: undefined,
      verifiedDestinationGeneration: undefined,
      failure: undefined,
      updatedAt: now,
    });
    return {
      ready: true as const,
      creationId: String(item.creationId),
      ticketId: String(ticketId),
      source: { assetStore: item.sourceStore, assetLocator: item.sourceLocator },
      destination,
      contentType: cleanContentType(item.sourceContentType),
      maxBytes: MAX_ASSET_BYTES,
    };
  },
});

export const verifyCopy = mutation({
  args: {
    creationId: v.id("creations"),
    ticketId: v.id("creationAssetStoreMigrationTickets"),
    sha256: v.string(),
    sizeBytes: v.number(),
    contentType: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const state = await migration(ctx);
    if (!state || (state.state !== "frozen" && state.state !== "cutover_ready")) {
      throw migrationFailure("migration is not accepting copy verification");
    }
    const item = await itemForCreation(ctx, migrationAttempt(state), args.creationId);
    const ticket: any = await ctx.db.get(args.ticketId);
    const now = Date.now();
    const destination = item ? currentDestination(item) : null;
    if (!item || !destination || !liveTicket(item, ticket, now)) {
      throw migrationFailure("migration copy ticket is no longer current");
    }
    const sha256 = cleanSha256(args.sha256);
    if (!Number.isSafeInteger(args.sizeBytes) || args.sizeBytes < 0 || args.sizeBytes > MAX_ASSET_BYTES) {
      throw migrationFailure("migration copy size is invalid");
    }
    const contentType = cleanContentType(args.contentType ?? item.sourceContentType);
    await ctx.db.patch(ticket._id, { state: "consumed", consumedAt: now });
    await ctx.db.patch(item._id, {
      state: "verified" satisfies ItemState,
      activeTicketId: undefined,
      claimExpiresAt: undefined,
      sha256,
      sizeBytes: args.sizeBytes,
      sourceContentType: contentType,
      // Cutover accepts only this exact ticket-bound generation, never a
      // mutable item destination that a later retry could have replaced.
      verifiedDestinationLocator: destination.assetLocator,
      verifiedDestinationGeneration: Number(item.destinationGeneration),
      verifiedAt: now,
      failure: undefined,
      updatedAt: now,
    });
    const verifiedCount = Number(state.verifiedCount) + 1;
    await ctx.db.patch(state._id, {
      verifiedCount,
      state: state.snapshotComplete && verifiedCount === Number(state.expectedCount)
        ? "cutover_ready" satisfies MigrationState
        : state.state,
      updatedAt: now,
    });
    const updated = await migration(ctx);
    if (!updated) throw migrationFailure("creation asset migration state disappeared");
    return stateSummary(updated);
  },
});

export const releaseCopy = mutation({
  args: {
    creationId: v.id("creations"),
    ticketId: v.id("creationAssetStoreMigrationTickets"),
    reason: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const state = await migration(ctx);
    if (!state || (state.state !== "frozen" && state.state !== "cutover_ready")) return false;
    const item = await itemForCreation(ctx, migrationAttempt(state), args.creationId);
    const ticket: any = await ctx.db.get(args.ticketId);
    const now = Date.now();
    if (!item || !liveTicket(item, ticket, now)) return false;
    const reason = args.reason?.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) || "copy attempt was not verified";
    await ctx.db.patch(ticket._id, { state: "revoked", consumedAt: now });
    // Do not delete the destination here. An accepted object-store PUT can
    // complete after this worker loses its response; the next claim receives
    // a new immutable generation instead of reusing this late-write target.
    await ctx.db.patch(item._id, {
      state: "pending" satisfies ItemState,
      activeTicketId: undefined,
      claimExpiresAt: undefined,
      failure: reason,
      updatedAt: now,
    });
    return true;
  },
});

// A deletion ticket is server-issued from the immutable item only. It does
// not accept a locator argument, and is intentionally separate from copy
// tickets. The initial migration never consumes it because V2 writes are kept
// for nonterminal retry/readback rather than risking a late-PUT deletion race.
export const issueDestinationDeletionTicket = mutation({
  args: { creationId: v.id("creations"), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const state = await migration(ctx);
    if (!state) throw migrationFailure("creation asset migration has not been started");
    const item = await itemForCreation(ctx, migrationAttempt(state), args.creationId);
    const destination = item ? verifiedDestination(item) : null;
    if (!item || item.state !== "cutover" || !destination) {
      throw migrationFailure("a verified cutover destination is required for cleanup");
    }
    const now = Date.now();
    const ticketId = await ctx.db.insert("creationAssetStoreMigrationTickets", {
      migrationKey: CREATION_ASSET_STORE_MIGRATION_KEY,
      attempt: migrationAttempt(state),
      itemId: item._id,
      creationId: item.creationId,
      purpose: "destination_delete",
      destinationStore: destination.assetStore,
      destinationLocator: destination.assetLocator,
      destinationGeneration: Number(item.verifiedDestinationGeneration),
      state: "active",
      expiresAt: now + COPY_LEASE_MS,
      createdAt: now,
    });
    return { ticketId: String(ticketId), creationId: String(item.creationId) };
  },
});

// The cutover is deliberately page-bounded and CAS-like: each row must still
// point at exactly the V1 snapshot source in the same serializable mutation.
// A mismatch freezes the migration instead of partially switching a library.
export const cutoverStep = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const state = await migration(ctx);
    if (!state) throw migrationFailure("creation asset migration has not been started");
    if (!state.snapshotComplete || Number(state.verifiedCount) !== Number(state.expectedCount)) {
      throw migrationFailure("full verified migration is required before cutover");
    }
    if (state.state === "cutover" || state.state === "activated") return stateSummary(state);
    if (state.state !== "cutover_ready" && state.state !== "cutting_over") {
      throw migrationFailure("migration is not ready for cutover");
    }
    const verified = await ctx.db
      .query("creationAssetStoreMigrationItems")
      .withIndex("by_migration_attempt_state", (q: any) => q
        .eq("migrationKey", CREATION_ASSET_STORE_MIGRATION_KEY)
        .eq("attempt", migrationAttempt(state))
        .eq("state", "verified"))
      .take(CUTOVER_PAGE_SIZE);
    const now = Date.now();
    if (!verified.length) {
      if (Number(state.cutoverCount) !== Number(state.expectedCount)) {
        await ctx.db.patch(state._id, {
          state: "failed" satisfies MigrationState,
          failure: "Verified migration manifest count did not match cutover count",
          updatedAt: now,
        });
        const failed = await migration(ctx);
        if (!failed) throw migrationFailure("creation asset migration state disappeared");
        return stateSummary(failed);
      }
      await ctx.db.patch(state._id, { state: "cutover" satisfies MigrationState, cutoverAt: now, updatedAt: now });
      const completed = await migration(ctx);
      if (!completed) throw migrationFailure("creation asset migration state disappeared");
      return stateSummary(completed);
    }
    for (const item of verified) {
      const creation: any = await ctx.db.get(item.creationId);
      const canonical = creation ? creationAssetLocatorFromRow(creation) : null;
      const destination = verifiedDestination(item);
      if (
        !canonical
        || canonical.assetStore !== item.sourceStore
        || canonical.assetLocator !== item.sourceLocator
        || !destination
      ) {
        await ctx.db.patch(state._id, {
          state: "failed" satisfies MigrationState,
          failure: "Creation or verified V2 generation changed after snapshot; refusing partial asset-store cutover",
          updatedAt: now,
        });
        const failed = await migration(ctx);
        if (!failed) throw migrationFailure("creation asset migration state disappeared");
        return stateSummary(failed);
      }
      await ctx.db.patch(creation._id, {
        assetStore: destination.assetStore,
        assetLocator: destination.assetLocator,
        // This mirror preserves deployed index/read compatibility, but explicit
        // store/locator remain authoritative and the V1 source lives only in
        // the immutable migration manifest.
        assetR2Key: destination.assetLocator,
        assetContentType: item.sourceContentType,
        updatedAt: now,
      });
      await ctx.db.patch(item._id, { state: "cutover" satisfies ItemState, updatedAt: now });
    }
    await ctx.db.patch(state._id, {
      state: "cutting_over" satisfies MigrationState,
      cutoverCount: Number(state.cutoverCount) + verified.length,
      updatedAt: now,
    });
    const updated = await migration(ctx);
    if (!updated) throw migrationFailure("creation asset migration state disappeared");
    return stateSummary(updated);
  },
});

// Activation is a durable transition, not an assertion/no-op. Creation writes
// inspect this exact persisted state before allowing any V2 locator.
export const activate = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const state = await migration(ctx);
    if (
      !state
      || (state.state !== "cutover" && state.state !== "activated")
      || !state.snapshotComplete
      || Number(state.expectedCount) !== Number(state.verifiedCount)
      || Number(state.expectedCount) !== Number(state.cutoverCount)
    ) {
      throw migrationFailure("V2 activation requires a complete verified CAS cutover");
    }
    if (state.state !== "activated") {
      const now = Date.now();
      await ctx.db.patch(state._id, {
        state: "activated" satisfies MigrationState,
        activatedAt: now,
        updatedAt: now,
      });
    }
    const activated = await migration(ctx);
    if (!activated) throw migrationFailure("creation asset migration state disappeared");
    return stateSummary(activated);
  },
});

export const status = query({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const state = await migration(ctx);
    return state ? stateSummary(state) : null;
  },
});
