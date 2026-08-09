import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireAdmin, validGuestId } from "./controlAuth";
import { captureCurrentState } from "./currentState";

/** One-time recovery for conversations created by the retired guest mode.
 * Pairing moves Daniel's own browser history into the owner thread, fences any
 * unfinished turn, and derives bounded current state before the guest identity
 * disappears. The mutation is idempotent. */
export const recoverGuestConversation = mutation({
  args: { authTokenHash: v.string(), guestId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.authTokenHash);
    if (!validGuestId(args.guestId)) throw new Error("Invalid retired guest partition");
    const sourceThread = `guest:${args.guestId}`;
    const targetThread = "main";
    const now = Date.now();

    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", sourceThread))
      .collect();
    for (const row of messages.slice().sort((left, right) => left.createdAt - right.createdAt)) {
      if (row.role === "user") {
        await captureCurrentState(ctx, {
          text: row.text,
          messageId: String(row._id),
          observedAt: row.createdAt,
        });
      }
      const unfinished = row.status === "pending" || row.status === "streaming";
      await ctx.db.patch(row._id, {
        threadId: targetThread,
        ...(unfinished ? { status: "error", lastProgressAt: now, claimToken: undefined } : {}),
        guestSlotReleased: undefined,
      });
    }

    const legacyRows = await ctx.db
      .query("chat")
      .withIndex("by_thread", (q: any) => q.eq("threadId", sourceThread))
      .collect();
    for (const row of legacyRows) await ctx.db.patch(row._id, { threadId: targetThread });

    const prefetches = await ctx.db
      .query("chatTurnPrefetches")
      .withIndex("by_thread", (q: any) => q.eq("threadId", sourceThread))
      .collect();
    for (const row of prefetches) await ctx.db.delete(row._id);

    const messageFiles = await ctx.db
      .query("messageFiles")
      .withIndex("by_thread_created", (q: any) => q.eq("threadId", sourceThread))
      .collect();
    for (const row of messageFiles) await ctx.db.patch(row._id, { threadId: targetThread });

    const threadFiles = await ctx.db
      .query("threadFiles")
      .withIndex("by_thread_updated", (q: any) => q.eq("threadId", sourceThread))
      .collect();
    for (const row of threadFiles) {
      const duplicate = await ctx.db
        .query("threadFiles")
        .withIndex("by_thread_file", (q: any) => q.eq("threadId", targetThread).eq("fileId", row.fileId))
        .first();
      if (duplicate) await ctx.db.delete(row._id);
      else await ctx.db.patch(row._id, { threadId: targetThread, updatedAt: now });
    }

    const guestSession = await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", sourceThread))
      .first();
    const mainSession = await ctx.db
      .query("chatSessions")
      .withIndex("by_thread", (q: any) => q.eq("threadId", targetThread))
      .first();
    if (guestSession) {
      if (mainSession) {
        await ctx.db.patch(mainSession._id, {
          status: "idle",
          lastActiveAt: Math.max(mainSession.lastActiveAt, guestSession.lastActiveAt),
        });
        await ctx.db.delete(guestSession._id);
      } else {
        await ctx.db.patch(guestSession._id, { threadId: targetThread, status: "idle" });
      }
    }

    const guestLimit = await ctx.db
      .query("chatGuestLimits")
      .withIndex("by_guest", (q: any) => q.eq("guestId", args.guestId))
      .first();
    if (guestLimit) await ctx.db.delete(guestLimit._id);
    return { migratedMessages: messages.length, migratedLegacyRows: legacyRows.length };
  },
});
