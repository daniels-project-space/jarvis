import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const VIEWER_LIFETIME_MS = 6 * 60 * 60 * 1000;

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
  if (await isAdminSession(ctx, credentials.authTokenHash)) return;
  const token = credentials.viewerToken;
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) throw new Error("Authentication required");
  const session = await ctx.db
    .query("viewerSessions")
    .withIndex("by_token", (q: any) => q.eq("token", token.toLowerCase()))
    .first();
  if (!session || session.expiresAt <= Date.now()) throw new Error("Authentication required");
}

export const createSession = mutation({
  args: { password: v.string(), tokenHash: v.string(), userAgent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const password = process.env.JARVIS_ADMIN_PASSWORD;
    if (!password || !constantTimeEqual(args.password, password) || !/^[a-f0-9]{64}$/i.test(args.tokenHash)) return false;
    const now = Date.now();
    const expired = await ctx.db
      .query("adminSessions")
      .withIndex("by_expiry", (q: any) => q.lt("expiresAt", now))
      .take(50);
    for (const session of expired) await ctx.db.delete(session._id);
    const tokenHash = args.tokenHash.toLowerCase();
    const existing = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("adminSessions", {
      tokenHash,
      userAgent: args.userAgent?.slice(0, 240),
      createdAt: now,
      expiresAt: now + SESSION_LIFETIME_MS,
    });
    return true;
  },
});

export const validateSession = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => await isAdminSession(ctx, args.tokenHash),
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
