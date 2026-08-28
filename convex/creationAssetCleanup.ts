import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { actorAuthArgs, requireActor } from "./controlAuth";
import {
  CREATION_ASSET_STORE_V1,
  CREATION_ASSET_STORE_V2,
  creationAssetLocatorFromInput,
  creationAssetLocatorFromWriteInput,
  type CreationAssetLocator,
} from "./creationAssetLocator";

// A lease only decides when a producer loses the right to commit a creation
// row. It deliberately does not claim to bound an already accepted R2 PUT.
export const CREATION_ASSET_WRITER_LEASE_MS = 5 * 60_000;
export const CREATION_ASSET_SETTLE_GRACE_MS = 2 * 60_000;
export const CREATION_ASSET_CLEANUP_LEASE_MS = 2 * 60_000;
// The scheduled reconciler is the durable reaper. This interval is a bounded
// operational cadence, not a terminal retention window: an unreferenced key
// remains eligible forever so a late R2 PUT is deleted on a later sweep.
export const CREATION_ASSET_SWEEP_INTERVAL_MS = 2 * 60 * 60_000;

type IntentState = "writing" | "cleanup_ready" | "cleanup_claimed" | "cleanup_sweep" | "cleaned";
type RecoveryKind = "write" | "deletion";

function cleanAssetIdentity(args: {
  assetR2Key?: string;
  assetStore?: string;
  assetLocator?: string;
}): CreationAssetLocator {
  const asset = creationAssetLocatorFromInput(args);
  if (!asset) {
    throw new ConvexError({ code: "INVALID_CREATION_ASSET_KEY", message: "Private creation asset identity is invalid" });
  }
  return asset;
}

function cleanWritableAssetIdentity(args: {
  assetR2Key?: string;
  assetStore?: string;
  assetLocator?: string;
}): CreationAssetLocator {
  const asset = creationAssetLocatorFromWriteInput(args);
  if (!asset) {
    throw new ConvexError({ code: "INVALID_CREATION_ASSET_KEY", message: "Private creation asset identity is invalid" });
  }
  return asset;
}

function cleanWriterEpoch(value: string): string {
  const epoch = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(epoch)) {
    throw new ConvexError({ code: "INVALID_CREATION_ASSET_WRITER", message: "Creation asset writer epoch is invalid" });
  }
  return epoch;
}

function cleanClaimToken(value: string): string {
  const token = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(token)) {
    throw new ConvexError({ code: "INVALID_CREATION_ASSET_CLAIM", message: "Creation asset cleanup claim is invalid" });
  }
  return token;
}

async function creationForAsset(ctx: { db: any }, assetR2Key: string) {
  return await ctx.db
    .query("creations")
    .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", assetR2Key))
    .first();
}

async function intentForAsset(ctx: { db: any }, assetR2Key: string) {
  return await ctx.db
    .query("creationAssetCleanupIntents")
    .withIndex("by_assetR2Key", (q: any) => q.eq("assetR2Key", assetR2Key))
    .first();
}

async function deletionTicketForIntent(ctx: { db: any }, intent: any): Promise<any | null> {
  return intent?.cleanupDeletionTicketId ? await ctx.db.get(intent.cleanupDeletionTicketId) : null;
}

async function clearDeletionTicket(ctx: { db: any }, intent: any): Promise<void> {
  const ticket = await deletionTicketForIntent(ctx, intent);
  if (ticket) await ctx.db.delete(ticket._id);
}

function recoveryKind(intent: any): RecoveryKind {
  // Unknown historical values are safer as write-origin: they keep sweeping
  // rather than assuming there cannot be a late object-store write.
  return intent?.recoveryKind === "deletion" ? "deletion" : "write";
}

function claimedAndLive(intent: any, now: number): boolean {
  return intent?.state === "cleanup_claimed" && Number(intent.cleanupClaimExpiresAt ?? 0) > now;
}

function writerMatches(intent: any, writerEpoch: string): boolean {
  return recoveryKind(intent) === "write" && intent?.writerEpoch === writerEpoch;
}

function writeLease(now: number) {
  const writerLeaseExpiresAt = now + CREATION_ASSET_WRITER_LEASE_MS;
  // Kept in the response for an older producer during a rolling deployment.
  // It is advisory only; no cleanup transition derives correctness from it.
  return { writerLeaseExpiresAt, writerDeadlineAt: writerLeaseExpiresAt };
}

function nextSweepAt(now: number): number {
  return now + CREATION_ASSET_SWEEP_INTERVAL_MS;
}

// The write reservation is immediately before an object-store PUT. Checking
// the durable migration row here closes the remaining gap between the freeze
// point and creations:create, so a newly selected V2 writer cannot upload an
// object that the frozen metadata layer would later reject.
async function assertPrivateAssetStoreWritable(ctx: { db: any }, asset: CreationAssetLocator): Promise<void> {
  const migration = await ctx.db
    .query("creationAssetStoreMigrations")
    .withIndex("by_key", (q: any) => q.eq("key", "private-creation-r2-v2"))
    .first();
  // A selected V2 writer must never upload before the durable activation
  // transition. This covers the object-store write that precedes the creation
  // mutation, so a selector flip cannot create orphaned V2 data during
  // preflight or a failed/aborted migration.
  if (asset.assetStore === CREATION_ASSET_STORE_V2 && migration?.state !== "activated") {
    throw new ConvexError({
      code: "CREATION_ASSET_V2_NOT_ACTIVATED",
      message: "Private creation assets cannot write to V2 before durable activation",
    });
  }
  if (!migration) return;
  if (asset.assetStore !== CREATION_ASSET_STORE_V1 && migration.state === "activated") {
    return;
  }
  if (migration.state === "activated") {
    throw new ConvexError({
      code: "CREATION_ASSET_V2_REQUIRED",
      message: "Private creation assets must use the activated V2 store",
    });
  }
  // Abort explicitly reopens V1 before any cutover. Every other persisted
  // state—including a failed migration—keeps writes frozen until an owner
  // chooses the audited recovery path.
  if (migration.state !== "aborted") {
    throw new ConvexError({
      code: "CREATION_ASSET_MIGRATION_FROZEN",
      message: "Private creation assets are frozen for their controlled storage migration",
    });
  }
}

// The Vercel deployment is deliberately rolled out before this Convex module.
// A private-asset deletion route uses this narrow capability check to fail
// closed during that bridge instead of deleting metadata without the durable
// deletion intent that only this module provides.
export const protocol = query({
  args: { ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    return { cleanupProtocol: "nonterminal-reaper-v1" as const };
  },
});

// Reserve before any R2 write. The owner-authenticated opaque key and exact
// writer epoch form the only retry identity; another writer cannot reuse it.
export const reserve = mutation({
  args: { assetR2Key: v.string(), assetStore: v.optional(v.string()), assetLocator: v.optional(v.string()), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanWritableAssetIdentity(args);
    await assertPrivateAssetStoreWritable(ctx, asset);
    const assetR2Key = asset.assetLocator;
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    if (await creationForAsset(ctx, assetR2Key)) {
      throw new ConvexError({
        code: "CREATION_ASSET_ALREADY_COMMITTED",
        message: "This private creation asset is already committed",
      });
    }
    const existing = await intentForAsset(ctx, assetR2Key);
    if (existing) {
      if (existing.state === "writing" && writerMatches(existing, writerEpoch) && Number(existing.nextActionAt) > now) {
        return {
          assetR2Key,
          assetStore: asset.assetStore,
          assetLocator: asset.assetLocator,
          writerLeaseExpiresAt: Number(existing.nextActionAt),
          writerDeadlineAt: Number(existing.writerDeadlineAt ?? existing.nextActionAt),
          idempotent: true,
        };
      }
      throw new ConvexError({
        code: "CREATION_ASSET_ALREADY_RECOVERING",
        message: "This private creation asset is no longer writable",
      });
    }
    const lease = writeLease(now);
    await ctx.db.insert("creationAssetCleanupIntents", {
      assetR2Key,
      assetStore: asset.assetStore,
      assetLocator: asset.assetLocator,
      writerEpoch,
      recoveryKind: "write" satisfies RecoveryKind,
      state: "writing" satisfies IntentState,
      nextActionAt: lease.writerLeaseExpiresAt,
      writerDeadlineAt: lease.writerDeadlineAt,
      createdAt: now,
      updatedAt: now,
    });
    return { assetR2Key, assetStore: asset.assetStore, assetLocator: asset.assetLocator, ...lease, idempotent: false };
  },
});

// Renew immediately before the R2 boundary. If the lease has elapsed, cleanup
// takes ownership and a delayed PUT may no longer create metadata; the durable
// reaper will continue deleting the opaque object if it later appears.
export const renewForWrite = mutation({
  args: { assetR2Key: v.string(), assetStore: v.optional(v.string()), assetLocator: v.optional(v.string()), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanAssetIdentity(args);
    const assetR2Key = asset.assetLocator;
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (creation) {
      if (intent) {
        await clearDeletionTicket(ctx, intent);
        await ctx.db.delete(intent._id);
      }
      throw new ConvexError({
        code: "CREATION_ASSET_ALREADY_COMMITTED",
        message: "This private creation asset is already committed",
      });
    }
    if (!intent || !writerMatches(intent, writerEpoch)) {
      throw new ConvexError({
        code: "CREATION_ASSET_WRITER_FENCED",
        message: "This private creation writer is no longer current",
      });
    }
    if (intent.state !== "writing" || Number(intent.nextActionAt) <= now) {
      if (intent.state === "writing") {
        await ctx.db.patch(intent._id, {
          state: "cleanup_ready" satisfies IntentState,
          nextActionAt: now,
          updatedAt: now,
        });
      }
      throw new ConvexError({
        code: "CREATION_ASSET_WRITER_EXPIRED",
        message: "This private creation writer lease expired before R2 write",
      });
    }
    const lease = writeLease(now);
    await ctx.db.patch(intent._id, {
      state: "writing" satisfies IntentState,
      nextActionAt: lease.writerLeaseExpiresAt,
      writerDeadlineAt: lease.writerDeadlineAt,
      updatedAt: now,
    });
    return lease;
  },
});

// Called after a successful R2 PUT before `creations:create`. A late writer
// never gets to revive metadata after recovery owns the key. Its completion
// instead makes the retained reaper eligible immediately (or lets an active
// cleanup claim delete the newly arrived object).
export const markWritten = mutation({
  args: { assetR2Key: v.string(), assetStore: v.optional(v.string()), assetLocator: v.optional(v.string()), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanAssetIdentity(args);
    const assetR2Key = asset.assetLocator;
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (creation) {
      if (intent) {
        await clearDeletionTicket(ctx, intent);
        await ctx.db.delete(intent._id);
      }
      return { state: "preserved" as const };
    }
    if (!intent) {
      await ctx.db.insert("creationAssetCleanupIntents", {
        assetR2Key,
        assetStore: asset.assetStore,
        assetLocator: asset.assetLocator,
        writerEpoch,
        recoveryKind: "write" satisfies RecoveryKind,
        state: "cleanup_ready" satisfies IntentState,
        nextActionAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { state: "cleanup_ready" as const, reopened: true };
    }
    if (claimedAndLive(intent, now)) return { state: "cleanup_claimed" as const };
    // A live writer belongs only to its exact epoch. A stale worker must not
    // turn another active writer into cleanup ownership before that lease
    // expires; after expiry the retained reaper already owns the key.
    if (intent.state === "writing" && Number(intent.nextActionAt) > now && !writerMatches(intent, writerEpoch)) {
      return { state: "writer_mismatch" as const };
    }
    if (intent.state === "writing" && writerMatches(intent, writerEpoch) && Number(intent.nextActionAt) > now) {
      return { state: "writing" as const };
    }
    await clearDeletionTicket(ctx, intent);
    await ctx.db.patch(intent._id, {
      state: "cleanup_ready" satisfies IntentState,
      nextActionAt: now,
      cleanupDeletionTicketId: undefined,
      cleanupClaimToken: undefined,
      cleanupClaimExpiresAt: undefined,
      updatedAt: now,
    });
    return { state: "cleanup_ready" as const, reopened: true };
  },
});

// Called after an uncertain write or creation result. It never deletes
// directly. Its retained intent is the source of truth even when an R2 request
// resolves after every producer-side deadline has elapsed.
export const abandon = mutation({
  args: { assetR2Key: v.string(), assetStore: v.optional(v.string()), assetLocator: v.optional(v.string()), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanAssetIdentity(args);
    const assetR2Key = asset.assetLocator;
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    const [existingCreation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (existingCreation) {
      if (intent) {
        await clearDeletionTicket(ctx, intent);
        await ctx.db.delete(intent._id);
      }
      return { state: "preserved" as const };
    }
    if (!intent) {
      await ctx.db.insert("creationAssetCleanupIntents", {
        assetR2Key,
        assetStore: asset.assetStore,
        assetLocator: asset.assetLocator,
        writerEpoch,
        recoveryKind: "write" satisfies RecoveryKind,
        state: "cleanup_ready" satisfies IntentState,
        nextActionAt: now + CREATION_ASSET_SETTLE_GRACE_MS,
        createdAt: now,
        updatedAt: now,
      });
      return { state: "cleanup_ready" as const, retryAfterMs: CREATION_ASSET_SETTLE_GRACE_MS };
    }
    if (claimedAndLive(intent, now)) return { state: "cleanup_claimed" as const };
    // See `markWritten`: only the epoch that owns a live writer lease may
    // abandon it. A stale caller becomes harmless until recovery owns it.
    if (intent.state === "writing" && Number(intent.nextActionAt) > now && !writerMatches(intent, writerEpoch)) {
      return { state: "writer_mismatch" as const };
    }
    const immediate = intent.state === "cleanup_sweep" || intent.state === "cleaned" || !writerMatches(intent, writerEpoch);
    await clearDeletionTicket(ctx, intent);
    await ctx.db.patch(intent._id, {
      state: "cleanup_ready" satisfies IntentState,
      nextActionAt: immediate ? now : now + CREATION_ASSET_SETTLE_GRACE_MS,
      cleanupDeletionTicketId: undefined,
      cleanupClaimToken: undefined,
      cleanupClaimExpiresAt: undefined,
      updatedAt: now,
    });
    return {
      state: "cleanup_ready" as const,
      retryAfterMs: immediate ? 0 : CREATION_ASSET_SETTLE_GRACE_MS,
    };
  },
});

// Compatibility cleanup for a creation that committed on an older Convex
// revision. The current `creations:create` consumes its intent atomically.
export const complete = mutation({
  args: { assetR2Key: v.string(), assetStore: v.optional(v.string()), assetLocator: v.optional(v.string()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanAssetIdentity(args);
    const assetR2Key = asset.assetLocator;
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (!creation || !intent) return false;
    await clearDeletionTicket(ctx, intent);
    await ctx.db.delete(intent._id);
    return true;
  },
});

// Claim is the first canonical-creation check. The bounded claim lease makes
// a delayed creation fail closed while a worker decides whether R2 may be
// deleted. It is not an R2 execution deadline.
export const claim = mutation({
  args: {
    assetR2Key: v.string(),
    assetStore: v.optional(v.string()),
    assetLocator: v.optional(v.string()),
    // Kept only while a previously deployed Trigger worker ages out. New
    // workers omit it and receive a Convex-issued deletion ticket instead.
    claimToken: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanAssetIdentity(args);
    const assetR2Key = asset.assetLocator;
    const claimToken = args.claimToken === undefined ? undefined : cleanClaimToken(args.claimToken);
    const now = Date.now();
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (!intent) return null;
    if (creation) {
      await clearDeletionTicket(ctx, intent);
      await ctx.db.delete(intent._id);
      return { ready: false as const, preserved: true as const };
    }
    if (claimedAndLive(intent, now)) {
      return { ready: false as const, retryAfterMs: Number(intent.cleanupClaimExpiresAt) - now };
    }
    if (Number(intent.nextActionAt) > now) {
      return { ready: false as const, retryAfterMs: Number(intent.nextActionAt) - now };
    }
    const cleanupClaimExpiresAt = now + CREATION_ASSET_CLEANUP_LEASE_MS;
    // A ticket is inserted by Convex after it has resolved the durable intent.
    // The current Trigger does not send a caller-generated token and cannot
    // select a storage coordinate or deletion capability on its own.
    await clearDeletionTicket(ctx, intent);
    const assetStore = typeof intent.assetStore === "string" ? intent.assetStore : asset.assetStore;
    const assetLocator = typeof intent.assetLocator === "string" ? intent.assetLocator : asset.assetLocator;
    const deletionTicketId = claimToken === undefined
      ? await ctx.db.insert("creationAssetCleanupTickets", {
        intentId: intent._id,
        assetStore,
        assetLocator,
        expiresAt: cleanupClaimExpiresAt,
        createdAt: now,
      })
      : undefined;
    await ctx.db.patch(intent._id, {
      state: "cleanup_claimed" satisfies IntentState,
      cleanupDeletionTicketId: deletionTicketId,
      cleanupClaimToken: claimToken,
      cleanupClaimExpiresAt,
      nextActionAt: cleanupClaimExpiresAt,
      updatedAt: now,
    });
    return {
      ready: true as const,
      assetR2Key,
      assetStore,
      assetLocator,
      ...(deletionTicketId ? { deletionTicketId: String(deletionTicketId) } : { claimToken }),
      cleanupClaimExpiresAt,
      cleanupProtocol: "nonterminal-reaper-v1" as const,
    };
  },
});

// Finish is the second canonical check, immediately after R2 deletion. Never
// terminalize an unreferenced key: R2 can complete a request after a client
// has stopped observing it. The intent is retained for the next bounded,
// globally scheduled sweep instead of creating a perpetual Trigger task.
export const finish = mutation({
  args: {
    assetR2Key: v.string(),
    assetStore: v.optional(v.string()),
    assetLocator: v.optional(v.string()),
    // See claim: old workers may complete a short staged legacy claim, while
    // all newly issued cleanup capabilities are opaque server ticket IDs.
    claimToken: v.optional(v.string()),
    deletionTicketId: v.optional(v.id("creationAssetCleanupTickets")),
    ...actorAuthArgs,
  },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const asset = cleanAssetIdentity(args);
    const assetR2Key = asset.assetLocator;
    const intent = await intentForAsset(ctx, assetR2Key);
    if (!intent || intent.state !== "cleanup_claimed") return false;
    const now = Date.now();
    let ticket: any = null;
    if (args.deletionTicketId !== undefined) {
      ticket = await ctx.db.get(args.deletionTicketId);
      if (
        !ticket
        || intent.cleanupDeletionTicketId === undefined
        || String(intent.cleanupDeletionTicketId) !== String(ticket._id)
        || String(ticket.intentId) !== String(intent._id)
        || ticket.assetStore !== asset.assetStore
        || ticket.assetLocator !== asset.assetLocator
        || Number(ticket.expiresAt) <= now
      ) return false;
    } else {
      if (args.claimToken === undefined || intent.cleanupClaimToken !== cleanClaimToken(args.claimToken)) return false;
    }
    const creation = await creationForAsset(ctx, assetR2Key);
    if (creation) {
      if (ticket) await ctx.db.delete(ticket._id);
      await ctx.db.delete(intent._id);
      return { finished: false as const, preserved: true as const };
    }
    if (ticket) await ctx.db.delete(ticket._id);
    await ctx.db.patch(intent._id, {
      state: "cleanup_sweep" satisfies IntentState,
      nextActionAt: nextSweepAt(now),
      cleanupDeletionTicketId: undefined,
      cleanupClaimToken: undefined,
      cleanupClaimExpiresAt: undefined,
      updatedAt: now,
    });
    return { finished: true as const, preserved: false as const };
  },
});

// The periodic reconciler returns a bounded batch. Each successful sweep moves
// its row into the future, so overdue rows naturally round-robin rather than
// one key creating an unbounded chain of delayed Trigger tasks. `cleaned` is
// retained here only to repair a row written by a previously staged revision.
export const pending = query({
  args: { limit: v.optional(v.number()), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const limit = Math.min(12, Math.max(1, Math.floor(args.limit ?? 4)));
    const now = Date.now();
    const expired = await Promise.all(
      (["writing", "cleanup_ready", "cleanup_claimed", "cleanup_sweep", "cleaned"] as const).map(async (state) =>
        await ctx.db
          .query("creationAssetCleanupIntents")
          .withIndex("by_state_action", (q: any) => q.eq("state", state).lte("nextActionAt", now))
          .take(limit),
      ),
    );
    const seen = new Set<string>();
    return expired
      .flat()
      .sort((left: any, right: any) => Number(left.nextActionAt) - Number(right.nextActionAt))
      .filter((intent: any) => {
        const asset = creationAssetLocatorFromInput(intent);
        if (!asset) return false;
        const identity = `${asset.assetStore}:${asset.assetLocator}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .slice(0, limit)
      .flatMap((intent: any) => {
        const asset = creationAssetLocatorFromInput(intent);
        return asset ? [{ assetR2Key: asset.assetLocator, assetStore: asset.assetStore, assetLocator: asset.assetLocator }] : [];
      });
  },
});
