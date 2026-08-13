import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, requireViewer, requireWorker, viewerAuthArgs } from "./controlAuth";

// Feature 4a: Gmail OAuth connect infrastructure.
//
// Single-row-per-provider store for Daniel's connected Google account. The
// refresh token is always encrypted (AES-256-GCM) by the caller before it
// reaches this file — see src/lib/google-oauth.ts for the cipher and for
// the access-token exchange that reads the row back.
//
// `getConnectionStatus` is the only query that is safe to wire into any
// future "Connect Google" UI: it never returns the encrypted token.
// `getEncryptedConnection` returns the ciphertext envelope and must stay
// server-only (called exclusively from src/lib/google-oauth.ts).

const PROVIDER_GOOGLE = "google";

export const upsertConnection = mutation({
  args: {
    encryptedRefreshToken: v.string(),
    scope: v.string(),
    email: v.optional(v.string()),
    // OAuth callbacks are initiated from an already-admin-authenticated
    // browser. Keep that proof on the mutation boundary too: a public
    // Convex mutation must never be able to replace Daniel's connection.
    authTokenHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const existing = await ctx.db
      .query("googleAccounts")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER_GOOGLE))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        encryptedRefreshToken: args.encryptedRefreshToken,
        scope: args.scope,
        email: args.email,
        updatedAt: now,
      });
      return { connected: true as const };
    }
    await ctx.db.insert("googleAccounts", {
      provider: PROVIDER_GOOGLE,
      encryptedRefreshToken: args.encryptedRefreshToken,
      scope: args.scope,
      email: args.email,
      connectedAt: now,
      updatedAt: now,
    });
    return { connected: true as const };
  },
});

export const getConnectionStatus = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, args) => {
    await requireViewer(ctx, args);
    const existing = await ctx.db
      .query("googleAccounts")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER_GOOGLE))
      .unique();
    if (!existing) return { connected: false as const };
    return {
      connected: true as const,
      email: existing.email,
      scope: existing.scope,
      connectedAt: existing.connectedAt,
      updatedAt: existing.updatedAt,
    };
  },
});

// Server-only accessor for src/lib/google-oauth.ts. Returns the encrypted
// envelope (useless without GOOGLE_TOKEN_ENCRYPTION_KEY) — do not add a
// plaintext-returning variant, and do not call this from client code.
export const getEncryptedConnection = query({
  args: { workerToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // The ciphertext envelope is still credential material: exposing it to
    // an arbitrary browser would make a later key/configuration mistake much
    // more damaging. Only trusted server/worker runtimes may load it.
    requireWorker(args.workerToken);
    const existing = await ctx.db
      .query("googleAccounts")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER_GOOGLE))
      .unique();
    if (!existing) return null;
    return {
      encryptedRefreshToken: existing.encryptedRefreshToken,
      scope: existing.scope,
    };
  },
});
