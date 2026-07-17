import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

// One bounded reactive read powers the whole command deck. This avoids a fan
// out of broad subscriptions and makes Convex I/O proportional to what can be
// rendered, not to the lifetime size of the tables.
export const snapshot = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const activeStatuses = ["running", "pending", "awaiting_approval", "paused", "needs_input"];
    const activeGroups = await Promise.all(
      activeStatuses.map((status) =>
        ctx.db
          .query("jobs")
          .withIndex("by_status", (q: any) => q.eq("status", status))
          .order("asc")
          .take(20),
      ),
    );
    const [approvals, attention, agents, projects, missions, recentCandidates] = await Promise.all([
      ctx.db
        .query("approvals")
        .withIndex("by_status", (q: any) => q.eq("status", "pending"))
        .order("desc")
        .take(12),
      ctx.db
        .query("attentionItems")
        .withIndex("by_status", (q: any) => q.eq("status", "open"))
        .order("desc")
        .take(20),
      ctx.db.query("agentProfiles").collect(),
      ctx.db.query("projectState").collect(),
      ctx.db.query("missions").withIndex("by_createdAt").order("desc").take(12),
      ctx.db.query("jobs").withIndex("by_createdAt").order("desc").take(30),
    ]);
    const score = (item: any) => item.impact * item.urgency * item.confidence;
    const active = activeGroups
      .flat()
      .sort((a: any, b: any) => (b.priority ?? 50) - (a.priority ?? 50) || a.createdAt - b.createdAt);
    const liveAgents = agents.map((profile) => {
      const owned = active.filter((job: any) => job.agentId === profile.slug);
      const executing = owned.find((job: any) => job.status === "running" || job.status === "pending");
      const blocked = owned.find((job: any) => ["needs_input", "paused", "awaiting_approval"].includes(job.status));
      return {
        ...profile,
        status: executing ? "working" : blocked ? "blocked" : "available",
        currentJobId: executing ? String(executing._id) : blocked ? String(blocked._id) : undefined,
      };
    });
    return {
      generatedAt: Date.now(),
      approvals,
      attention: attention.sort((a: any, b: any) => score(b) - score(a)).slice(0, 8),
      active,
      agents: liveAgents.sort((a: any, b: any) => (a.slug === "jarvis" ? -1 : b.slug === "jarvis" ? 1 : a.name.localeCompare(b.name))),
      projects: projects.sort((a: any, b: any) => a.slug.localeCompare(b.slug)),
      missions,
      recent: recentCandidates
        .filter((j: any) => ["done", "error", "cancelled"].includes(j.status))
        .slice(0, 8),
    };
  },
});
