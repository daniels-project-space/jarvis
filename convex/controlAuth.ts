import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_PAIRING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_EMBED_SESSION_LIFETIME_MS = SESSION_LIFETIME_MS;
const VIEWER_LIFETIME_MS = 6 * 60 * 60 * 1000;
const VIEWER_ISSUER = "https://jarvis-orcin-six.vercel.app";
const VIEWER_SUBJECT = "daniel-owner";

export const actorAuthArgs = {
  authTokenHash: v.optional(v.string()),
  workerToken: v.optional(v.string()),
  // Kept temporarily as an input-compatibility field while old clients age
  // out. It grants no identity or access; requireActor always ignores it.
  guestId: v.optional(v.string()),
};

export const dispatcherAuthArgs = {
  ...actorAuthArgs,
  dispatchToken: v.optional(v.string()),
};

// User-facing control may arrive from Daniel's live admin session or from the
// trusted server-side dispatcher. Unlike dispatcherAuthArgs, this capability
// deliberately excludes workers: execution authority is not control authority.
export const ownerDispatcherAuthArgs = {
  authTokenHash: v.optional(v.string()),
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

export function hasWorkerCapability(workerToken: string | undefined): boolean {
  const expected = process.env.JARVIS_WORKER_TOKEN;
  return Boolean(expected && constantTimeEqual(workerToken, expected));
}

export function requireWorker(workerToken: string | undefined): void {
  if (!hasWorkerCapability(workerToken)) throw new Error("Unauthorized worker capability");
}

/**
 * File-derived-artifact rehoming can make a one-way protocol cutover
 * available. Keep that authority separate from the broadly-used worker token:
 * an ordinary ingestion/cleanup worker must never be able to certify the
 * migration or repoint an existing private-file pointer.
 */
export function hasFileDerivedArtifactRehomeCapability(token: string | undefined): boolean {
  const expected = process.env.JARVIS_FILE_REHOME_TOKEN;
  return Boolean(expected && constantTimeEqual(token, expected));
}

export function requireFileDerivedArtifactRehome(token: string | undefined): void {
  if (!hasFileDerivedArtifactRehomeCapability(token)) {
    throw new Error("Unauthorized file-derived-artifact rehome capability");
  }
}

export async function isAdminSession(ctx: any, tokenHash: string | undefined): Promise<boolean> {
  if (!tokenHash || !/^[a-f0-9]{64}$/i.test(tokenHash)) return false;
  const session = await ctx.db
    .query("adminSessions")
    .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash.toLowerCase()))
    .first();
  return Boolean(session && typeof session.enrolledAt === "number" && session.expiresAt > Date.now());
}

export async function requireAdmin(ctx: any, tokenHash: string | undefined): Promise<void> {
  if (!(await isAdminSession(ctx, tokenHash))) throw new Error("Authentication required");
}

export async function requireActor(
  ctx: any,
  credentials: { authTokenHash?: string; workerToken?: string },
): Promise<void> {
  if (hasWorkerCapability(credentials.workerToken)) return;
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

export async function requireOwnerOrDispatcher(
  ctx: Parameters<typeof requireAdmin>[0],
  credentials: { authTokenHash?: string; dispatchToken?: string },
): Promise<void> {
  const dispatcher = process.env.JARVIS_DISPATCH_TOKEN;
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
  if (!session || session.expiresAt <= Date.now() || !(await isAdminSession(ctx, session.adminTokenHash))) {
    throw new Error("Authentication required");
  }
}

export function guestThreadId(guestId: string): string {
  return `guest:${guestId}`;
}

export function validGuestId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{32,128}$/.test(value));
}

export async function conversationIdentity(ctx: any, credentials: { guestId?: string; authTokenHash?: string; workerToken?: string }) {
  await requireActor(ctx, credentials);
  return { kind: "owner" as const };
}

export async function conversationViewerIdentity(ctx: any, credentials: { authTokenHash?: string; workerToken?: string }) {
  const identity = await ctx.auth?.getUserIdentity?.();
  if (identity?.issuer === VIEWER_ISSUER && identity?.subject === VIEWER_SUBJECT) return { kind: "owner" as const };
  if (await isAdminSession(ctx, credentials.authTokenHash)) return { kind: "owner" as const };
  const worker = process.env.JARVIS_WORKER_TOKEN;
  if (worker && constantTimeEqual(credentials.workerToken, worker)) return { kind: "owner" as const };
  throw new Error("Authentication required");
}

export function scopedConversationThread(identity: { kind: "owner" } | { kind: "guest"; guestId: string }, requested: string | undefined): string {
  if (identity.kind === "guest") return guestThreadId(identity.guestId);
  return requested?.trim() || "main";
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
    if (!session || typeof session.enrolledAt !== "number" || session.expiresAt <= Date.now()) return { valid: false };
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

// Guest conversation opens without a sign-in. Owner authority is different:
// this mutation is reachable only from the server-side enrollment gate and
// never from the ordinary viewer bootstrap.
export const createOpenSession = mutation({
  args: {
    ownerTokenHash: v.string(),
    userAgent: v.optional(v.string()),
    workerToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    if (!/^[a-f0-9]{64}$/i.test(args.ownerTokenHash)) return false;
    const now = Date.now();
    const ownerTokenHash = args.ownerTokenHash.toLowerCase();
    const existing = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", ownerTokenHash))
      .first();
    const expiresAt = now + SESSION_LIFETIME_MS;
    if (existing) {
      await ctx.db.patch(existing._id, { userAgent: args.userAgent?.slice(0, 240), enrolledAt: now, expiresAt });
    } else {
      await ctx.db.insert("adminSessions", {
        tokenHash: ownerTokenHash,
        userAgent: args.userAgent?.slice(0, 240),
        createdAt: now,
        enrolledAt: now,
        expiresAt,
      });
    }
    return { expiresAt };
  },
});

export const createOwnerPairingTicket = mutation({
  args: {
    tokenHash: v.string(),
    expiresAt: v.number(),
    workerToken: v.string(),
  },
  handler: async (ctx, args) => {
    requireWorker(args.workerToken);
    const now = Date.now();
    if (!/^[a-f0-9]{64}$/i.test(args.tokenHash)) throw new Error("Invalid pairing ticket");
    if (args.expiresAt <= now || args.expiresAt > now + MAX_PAIRING_LIFETIME_MS) {
      throw new Error("Invalid pairing expiry");
    }
    const tokenHash = args.tokenHash.toLowerCase();
    const existing = await ctx.db
      .query("ownerPairingTickets")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    if (existing) throw new Error("Pairing ticket already exists");
    const expired = await ctx.db
      .query("ownerPairingTickets")
      .withIndex("by_expiry", (q: any) => q.lt("expiresAt", now))
      .take(100);
    for (const ticket of expired) await ctx.db.delete(ticket._id);
    await ctx.db.insert("ownerPairingTickets", { tokenHash, createdAt: now, expiresAt: args.expiresAt });
    return { expiresAt: args.expiresAt };
  },
});

export const consumeOwnerPairingTicket = mutation({
  args: {
    tokenHash: v.string(),
    ownerTokenHash: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/i.test(args.tokenHash) || !/^[a-f0-9]{64}$/i.test(args.ownerTokenHash)) {
      return false;
    }
    const now = Date.now();
    const ticket = await ctx.db
      .query("ownerPairingTickets")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", args.tokenHash.toLowerCase()))
      .first();
    if (!ticket || ticket.consumedAt || ticket.expiresAt <= now) return false;

    // Convex mutations are serializable, so consuming the ticket and creating
    // the owner session is one atomic transition. A replay cannot enroll a
    // second browser even if two requests arrive together.
    await ctx.db.patch(ticket._id, { consumedAt: now });
    const ownerTokenHash = args.ownerTokenHash.toLowerCase();
    const existingSession = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", ownerTokenHash))
      .first();
    const expiresAt = now + SESSION_LIFETIME_MS;
    if (existingSession) {
      await ctx.db.patch(existingSession._id, {
        userAgent: args.userAgent?.slice(0, 240),
        enrolledAt: now,
        expiresAt,
      });
    } else {
      await ctx.db.insert("adminSessions", {
        tokenHash: ownerTokenHash,
        userAgent: args.userAgent?.slice(0, 240),
        createdAt: now,
        enrolledAt: now,
        expiresAt,
      });
    }
    return { expiresAt };
  },
});

export const createEmbedControlSession = mutation({
  args: {
    authTokenHash: v.string(),
    tokenHash: v.string(),
    hostOrigin: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    const now = Date.now();
    if (!/^[a-f0-9]{64}$/i.test(args.tokenHash)) throw new Error("Invalid embed capability");
    if (args.expiresAt <= now || args.expiresAt > now + MAX_EMBED_SESSION_LIFETIME_MS) {
      throw new Error("Invalid embed expiry");
    }
    let hostOrigin: string;
    try {
      const parsed = new URL(args.hostOrigin);
      if (parsed.origin !== args.hostOrigin || parsed.protocol !== "https:") throw new Error();
      hostOrigin = parsed.origin;
    } catch {
      throw new Error("Invalid embed origin");
    }
    const tokenHash = args.tokenHash.toLowerCase();
    const existing = await ctx.db
      .query("embedControlSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", tokenHash))
      .first();
    if (existing) throw new Error("Embed capability already exists");
    const expired = await ctx.db
      .query("embedControlSessions")
      .withIndex("by_expiry", (q: any) => q.lt("expiresAt", now))
      .take(100);
    for (const session of expired) await ctx.db.delete(session._id);
    await ctx.db.insert("embedControlSessions", {
      tokenHash,
      adminTokenHash: args.authTokenHash.toLowerCase(),
      hostOrigin,
      createdAt: now,
      expiresAt: args.expiresAt,
    });
    return { expiresAt: args.expiresAt };
  },
});

export const embedControlSessionStatus = query({
  args: { tokenHash: v.string(), hostOrigin: v.string(), workerToken: v.string() },
  handler: async (ctx, args) => {
    // This resolver returns the backing admin-session hash so the trusted
    // Next.js boundary can translate a host-bound embed capability into the
    // existing Convex credential shape. Never expose that credential through
    // an anonymously callable status query: the embed token must remain
    // scoped, revocable, and non-exchangeable.
    requireWorker(args.workerToken);
    if (!/^[a-f0-9]{64}$/i.test(args.tokenHash)) return { valid: false };
    const session = await ctx.db
      .query("embedControlSessions")
      .withIndex("by_token", (q: any) => q.eq("tokenHash", args.tokenHash.toLowerCase()))
      .first();
    if (
      !session
      || session.revokedAt
      || session.expiresAt <= Date.now()
      || session.hostOrigin !== args.hostOrigin
      || !(await isAdminSession(ctx, session.adminTokenHash))
    ) return { valid: false };
    return { valid: true, authTokenHash: session.adminTokenHash, expiresAt: session.expiresAt };
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
