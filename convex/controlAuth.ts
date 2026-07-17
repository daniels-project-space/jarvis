import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const VIEWER_LIFETIME_MS = 6 * 60 * 60 * 1000;
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const VIEWER_ISSUER = "https://jarvis-orcin-six.vercel.app";
const VIEWER_SUBJECT = "daniel-owner";

export const actorAuthArgs = {
  authTokenHash: v.optional(v.string()),
  workerToken: v.optional(v.string()),
};

export const dispatcherAuthArgs = {
  ...actorAuthArgs,
  dispatchToken: v.optional(v.string()),
};

export const viewerAuthArgs = {
  ...dispatcherAuthArgs,
  viewerToken: v.optional(v.string()),
};

function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  const a = left ?? "";
  const b = right ?? "";
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(index % Math.max(1, b.length)) || 0);
  }
  return mismatch === 0 && a.length > 0;
}

export function requireWorker(workerToken: string | undefined): void {
  const expected = process.env.JARVIS_WORKER_TOKEN;
  if (!expected || !constantTimeEqual(workerToken, expected)) throw new Error("Unauthorized worker capability");
}

export async function isAdminSession(ctx: any, tokenHash: string | undefined): Promise<boolean> {
  if (!tokenHash || !/^[a-f0-9]{64}$/i.test(tokenHash)) return false;
  const session = await ctx.db
    .query("adminSessions")
    .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash.toLowerCase()))
    .first();
  return Boolean(session && session.expiresAt > Date.now());
}

export async function requireAdmin(ctx: any, tokenHash: string | undefined): Promise<void> {
  if (!(await isAdminSession(ctx, tokenHash))) throw new Error("Authentication required");
}

export async function requireActor(
  ctx: any,
  credentials: { authTokenHash?: string; workerToken?: string },
): Promise<void> {
  const worker = process.env.JARVIS_WORKER_TOKEN;
  if (worker && constantTimeEqual(credentials.workerToken, worker)) return;
  await requireAdmin(ctx, credentials.authTokenHash);
}

export async function requireDispatcher(
  ctx: any,
  credentials: { authTokenHash?: string; dispatchToken?: string; workerToken?: string },
): Promise<void> {
  const worker = process.env.JARVIS_WORKER_TOKEN;
  const dispatcher = process.env.JARVIS_DISPATCH_TOKEN;
  if (worker && constantTimeEqual(credentials.workerToken, worker)) return;
  if (dispatcher && constantTimeEqual(credentials.dispatchToken, dispatcher)) return;
  await requireAdmin(ctx, credentials.authTokenHash);
}

export async function requireViewer(
  ctx: any,
  credentials: { viewerToken?: string; authTokenHash?: string; dispatchToken?: string; workerToken?: string },
): Promise<void> {
  const worker = process.env.JARVIS_WORKER_TOKEN;
  const dispatcher = process.env.JARVIS_DISPATCH_TOKEN;
  if (worker && constantTimeEqual(credentials.workerToken, worker)) return;
  if (dispatcher && constantTimeEqual(credentials.dispatchToken, dispatcher)) return;
  const identity = await ctx.auth?.getUserIdentity?.();
  if (identity?.issuer === VIEWER_ISSUER && identity?.subject === VIEWER_SUBJECT) return;
  if (await isAdminSession(ctx, credentials.authTokenHash)) return;
  const token = credentials.viewerToken;
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) throw new Error("Authentication required");
  const session = await ctx.db
    .query("viewerSessions")
    .withIndex("by_token", (q: any) => q.eq("token", token.toLowerCase()))
    .first();
  if (!session || session.expiresAt <= Date.now()) throw new Error("Authentication required");
}

export const validateSession = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => await isAdminSession(ctx, args.tokenHash),
});

export const sessionStatus = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/i.test(args.tokenHash)) return { valid: false };
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", args.tokenHash.toLowerCase()))
      .first();
    if (!session || session.expiresAt <= Date.now()) return { valid: false };
    return { valid: true, expiresAt: session.expiresAt };
  },
});

export const refreshSession = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.tokenHash);
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", args.tokenHash.toLowerCase()))
      .first();
    if (!session) return false;
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    await ctx.db.patch(session._id, { expiresAt });
    return { expiresAt };
  },
});

async function storeDevicePairing(ctx: any, rawTokenHash: string) {
  if (!/^[a-f0-9]{64}$/i.test(rawTokenHash)) throw new Error("Invalid pairing capability");
  const now = Date.now();
  const stale = await ctx.db
    .query("devicePairings")
    .withIndex("by_expiry", (q: any) => q.lt("expiresAt", now))
    .take(50);
  for (const pairing of stale) await ctx.db.delete(pairing._id);
  const tokenHash = rawTokenHash.toLowerCase();
  const existing = await ctx.db
    .query("devicePairings")
    .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
    .first();
  if (existing) await ctx.db.delete(existing._id);
  const expiresAt = now + PAIRING_LIFETIME_MS;
  await ctx.db.insert("devicePairings", { tokenHash, status: "active", createdAt: now, expiresAt });
  return { expiresAt };
}

export const createDevicePairing = mutation({
  args: {
    tokenHash: v.string(),
    authTokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    return await storeDevicePairing(ctx, args.tokenHash);
  },
});

// Project Hub's recovery bridge holds only the narrow request bearer. The
// Jarvis route converts that request into the existing dispatcher capability;
// it cannot mint admin sessions directly or call any other control mutation.
export const createDevicePairingForDispatcher = mutation({
  args: {
    tokenHash: v.string(),
    dispatchToken: v.string(),
  },
  handler: async (ctx, args) => {
    await requireDispatcher(ctx, { dispatchToken: args.dispatchToken });
    return await storeDevicePairing(ctx, args.tokenHash);
  },
});

export const redeemDevicePairing = mutation({
  args: { tokenHash: v.string(), ownerTokenHash: v.string(), userAgent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/i.test(args.tokenHash) || !/^[a-f0-9]{64}$/i.test(args.ownerTokenHash)) return false;
    const now = Date.now();
    const pairing = await ctx.db
      .query("devicePairings")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", args.tokenHash.toLowerCase()))
      .first();
    if (!pairing || pairing.status !== "active" || pairing.expiresAt <= now) return false;

    await ctx.db.patch(pairing._id, { status: "used", usedAt: now });
    const ownerTokenHash = args.ownerTokenHash.toLowerCase();
    const existing = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", ownerTokenHash))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("adminSessions", {
      tokenHash: ownerTokenHash,
      userAgent: args.userAgent?.slice(0, 240),
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME_MS,
    });
    return true;
  },
});

export const createViewerSession = mutation({
  args: { authTokenHash: v.string(), viewerToken: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    if (!/^[a-f0-9]{64}$/i.test(args.viewerToken)) return false;
    const now = Date.now();
    const expired = await ctx.db
      .query("viewerSessions")
      .withIndex("by_expiry", (q: any) => q.lt("expiresAt", now))
      .take(100);
    for (const session of expired) await ctx.db.delete(session._id);
    const token = args.viewerToken.toLowerCase();
    const existing = await ctx.db
      .query("viewerSessions")
      .withIndex("by_token", (q: any) => q.eq("token", token))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("viewerSessions", {
      token,
      adminTokenHash: args.authTokenHash.toLowerCase(),
      createdAt: now,
      expiresAt: now + VIEWER_LIFETIME_MS,
    });
    return { token, expiresAt: now + VIEWER_LIFETIME_MS };
  },
});

export const revokeSession = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", args.tokenHash.toLowerCase()))
      .first();
    if (!session) return false;
    const viewers = await ctx.db
      .query("viewerSessions")
      .withIndex("by_admin", (q: any) => q.eq("adminTokenHash", args.tokenHash.toLowerCase()))
      .collect();
    for (const viewer of viewers) await ctx.db.delete(viewer._id);
    await ctx.db.delete(session._id);
    return true;
  },
});
