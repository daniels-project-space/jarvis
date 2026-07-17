import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

// The always-warm conversational lane needs enough continuity to be useful,
// not the full business/project control-plane snapshot. Keeping this bounded
// makes minting a new Realtime credential fast enough to protect the first
// typed turn after a reload or reconnect.
export const snapshot = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const [activeThread, panel, memory] = await Promise.all([
      ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first(),
      ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first(),
      ctx.db.query("memory").withIndex("by_createdAt").order("desc").take(4),
    ]);
    const threadId = activeThread?.value || "main";
    const conversation = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
      .order("desc")
      .take(16);
    return { threadId, panel, memory, conversation: conversation.reverse(), generatedAt: Date.now() };
  },
});
