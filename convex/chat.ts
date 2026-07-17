import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

export const appendTurn = mutation({
  args: {
    threadId: v.string(),
    userContent: v.string(),
    assistantContent: v.string(),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const now = Date.now();
    await ctx.db.insert("chat", { threadId: a.threadId, role: "user", content: a.userContent, createdAt: now });
    await ctx.db.insert("chat", { threadId: a.threadId, role: "assistant", content: a.assistantContent, createdAt: now + 1 });
  },
});

export const getMessages = query({
  args: { threadId: v.string(), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const lim = a.limit ?? 20;
    const rows = await ctx.db
      .query("chat")
      .withIndex("by_thread", (q) => q.eq("threadId", a.threadId))
      .order("desc")
      .take(lim);
    return rows.reverse();
  },
});
