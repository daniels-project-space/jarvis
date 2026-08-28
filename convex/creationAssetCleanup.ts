import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { actorAuthArgs, requireActor } from "./controlAuth";
import { isPrivateCreationAssetKey } from "./creations";

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

function cleanAssetR2Key(value: string): string {
  const key = value;
  if (!isPrivateCreationAssetKey(key)) {
    throw new ConvexError({ code: "INVALID_CREATION_ASSET_KEY", message: "Private creation asset identity is invalid" });
  }
  return key;
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
  args: { assetR2Key: v.string(), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
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
      writerEpoch,
      recoveryKind: "write" satisfies RecoveryKind,
      state: "writing" satisfies IntentState,
      nextActionAt: lease.writerLeaseExpiresAt,
      writerDeadlineAt: lease.writerDeadlineAt,
      createdAt: now,
      updatedAt: now,
    });
    return { assetR2Key, ...lease, idempotent: false };
  },
});

// Renew immediately before the R2 boundary. If the lease has elapsed, cleanup
// takes ownership and a delayed PUT may no longer create metadata; the durable
// reaper will continue deleting the opaque object if it later appears.
export const renewForWrite = mutation({
  args: { assetR2Key: v.string(), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (creation) {
      if (intent) await ctx.db.delete(intent._id);
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
  args: { assetR2Key: v.string(), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (creation) {
      if (intent) await ctx.db.delete(intent._id);
      return { state: "preserved" as const };
    }
    if (!intent) {
      await ctx.db.insert("creationAssetCleanupIntents", {
        assetR2Key,
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
    await ctx.db.patch(intent._id, {
      state: "cleanup_ready" satisfies IntentState,
      nextActionAt: now,
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
  args: { assetR2Key: v.string(), writerEpoch: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
    const writerEpoch = cleanWriterEpoch(args.writerEpoch);
    const now = Date.now();
    const [existingCreation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (existingCreation) {
      if (intent) await ctx.db.delete(intent._id);
      return { state: "preserved" as const };
    }
    if (!intent) {
      await ctx.db.insert("creationAssetCleanupIntents", {
        assetR2Key,
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
    await ctx.db.patch(intent._id, {
      state: "cleanup_ready" satisfies IntentState,
      nextActionAt: immediate ? now : now + CREATION_ASSET_SETTLE_GRACE_MS,
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
  args: { assetR2Key: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (!creation || !intent) return false;
    await ctx.db.delete(intent._id);
    return true;
  },
});

// Claim is the first canonical-creation check. The bounded claim lease makes
// a delayed creation fail closed while a worker decides whether R2 may be
// deleted. It is not an R2 execution deadline.
export const claim = mutation({
  args: { assetR2Key: v.string(), claimToken: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
    const claimToken = cleanClaimToken(args.claimToken);
    const now = Date.now();
    const [creation, intent] = await Promise.all([
      creationForAsset(ctx, assetR2Key),
      intentForAsset(ctx, assetR2Key),
    ]);
    if (!intent) return null;
    if (creation) {
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
    await ctx.db.patch(intent._id, {
      state: "cleanup_claimed" satisfies IntentState,
      cleanupClaimToken: claimToken,
      cleanupClaimExpiresAt,
      nextActionAt: cleanupClaimExpiresAt,
      updatedAt: now,
    });
    return {
      ready: true as const,
      assetR2Key,
      claimToken,
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
  args: { assetR2Key: v.string(), claimToken: v.string(), ...actorAuthArgs },
  handler: async (ctx, args) => {
    await requireActor(ctx, args);
    const assetR2Key = cleanAssetR2Key(args.assetR2Key);
    const claimToken = cleanClaimToken(args.claimToken);
    const intent = await intentForAsset(ctx, assetR2Key);
    if (!intent || intent.state !== "cleanup_claimed" || intent.cleanupClaimToken !== claimToken) return false;
    const creation = await creationForAsset(ctx, assetR2Key);
    if (creation) {
      await ctx.db.delete(intent._id);
      return { finished: false as const, preserved: true as const };
    }
    const now = Date.now();
    await ctx.db.patch(intent._id, {
      state: "cleanup_sweep" satisfies IntentState,
      nextActionAt: nextSweepAt(now),
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
        if (seen.has(intent.assetR2Key)) return false;
        seen.add(intent.assetR2Key);
        return true;
      })
      .slice(0, limit)
      .map((intent: any) => ({ assetR2Key: intent.assetR2Key }));
  },
});
