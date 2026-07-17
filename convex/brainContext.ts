import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

// A single bounded snapshot replaces the former 10-call Convex fan-out used
// by every chat and Realtime session. Keep payloads concise: this is model
// context, while full artifacts remain addressable by id.
export const snapshot = query({
  args: { userText: v.optional(v.string()), includeConversation: v.optional(v.boolean()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
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
    const [memHit, memRecent, business, projects, activeGroups, findings, trip, draft, location, panel, agents, attentionGroups, approvals, goalGroups] =
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
        Promise.all(
          ["open", "working"].map((status) =>
            ctx.db
              .query("attentionItems")
              .withIndex("by_status", (q: any) => q.eq("status", status))
              .order("desc")
              .take(8),
          ),
        ),
        ctx.db
          .query("approvals")
          .withIndex("by_status", (q: any) => q.eq("status", "pending"))
          .order("desc")
          .take(8),
        Promise.all(
          ["active", "blocked"].map((status) =>
            ctx.db
              .query("projectGoals")
              .withIndex("by_status_priority", (q: any) => q.eq("status", status))
              .order("desc")
              .take(20),
          ),
        ),
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
      goals: goalGroups.flat().sort((left: any, right: any) => right.priority - left.priority).slice(0, 24),
      jobs: activeJobs,
      findings,
      trip,
      draft,
      location,
      panel,
      agents: liveAgents,
      attention: attentionGroups.flat().sort(
        (x: any, y: any) => y.impact * y.urgency * y.confidence - x.impact * x.urgency * x.confidence,
      ).slice(0, 12),
      approvals,
      threadId,
      conversation,
      generatedAt: Date.now(),
    };
  },
});
