import { query } from "./_generated/server";
import { v } from "convex/values";

// A single bounded snapshot replaces the former 10-call Convex fan-out used
// by every chat and Realtime session. Keep payloads concise: this is model
// context, while full artifacts remain addressable by id.
export const snapshot = query({
  args: { userText: v.optional(v.string()), includeConversation: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const text = a.userText?.trim().slice(0, 240);
    let threadId = "main";
    let conversation: any[] = [];
    if (a.includeConversation) {
      const activeThread = await ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first();
      threadId = activeThread?.value || "main";
      conversation = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
        .order("desc")
        .take(60);
      conversation.reverse();
    }
    const activeStatuses = ["running", "pending", "awaiting_approval", "paused", "needs_input"];
    const [memHit, memRecent, business, projects, activeGroups, findings, trip, draft, location, panel, agents, attention, approvals] =
      await Promise.all([
        text
          ? ctx.db
              .query("memory")
              .withSearchIndex("search_body", (q) => q.search("body", text))
              .take(8)
          : Promise.resolve([]),
        ctx.db.query("memory").withIndex("by_createdAt").order("desc").take(6),
        ctx.db.query("businessState").collect(),
        ctx.db.query("projectState").collect(),
        Promise.all(
          activeStatuses.map((status) =>
            ctx.db
              .query("jobs")
              .withIndex("by_status", (q: any) => q.eq("status", status))
              .take(12),
          ),
        ),
        ctx.db
          .query("findings")
          .withIndex("by_status", (q: any) => q.eq("status", "fresh"))
          .order("desc")
          .take(12),
        ctx.db
          .query("creations")
          .withIndex("by_kind", (q: any) => q.eq("kind", "trip"))
          .order("desc")
          .first(),
        ctx.db
          .query("creations")
          .withIndex("by_kind", (q: any) => q.eq("kind", "doc"))
          .order("desc")
          .first(),
        ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "location")).first(),
        ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "panel")).first(),
        ctx.db.query("agentProfiles").collect(),
        ctx.db
          .query("attentionItems")
          .withIndex("by_status", (q: any) => q.eq("status", "open"))
          .order("desc")
          .take(8),
        ctx.db
          .query("approvals")
          .withIndex("by_status", (q: any) => q.eq("status", "pending"))
          .order("desc")
          .take(8),
      ]);
    const activeJobs = activeGroups.flat().sort((x: any, y: any) => (y.priority ?? 50) - (x.priority ?? 50));
    const liveAgents = agents.map((profile) => {
      const owned = activeJobs.filter((job: any) => job.agentId === profile.slug);
      const executing = owned.find((job: any) => job.status === "running" || job.status === "pending");
      const blocked = owned.find((job: any) => ["needs_input", "paused", "awaiting_approval"].includes(job.status));
      return {
        ...profile,
        status: executing ? "working" : blocked ? "blocked" : "available",
        currentJobId: executing ? String(executing._id) : blocked ? String(blocked._id) : undefined,
      };
    });
    return {
      memory: [...memHit, ...memRecent].filter(
        (row: any, index: number, all: any[]) => all.findIndex((candidate: any) => candidate._id === row._id) === index,
      ).slice(0, 10),
      business,
      projects,
      jobs: activeJobs,
      findings,
      trip,
      draft,
      location,
      panel,
      agents: liveAgents,
      attention: attention.sort(
        (x: any, y: any) => y.impact * y.urgency * y.confidence - x.impact * x.urgency * x.confidence,
      ),
      approvals,
      threadId,
      conversation,
      generatedAt: Date.now(),
    };
  },
});
