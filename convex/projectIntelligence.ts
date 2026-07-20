import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";
import { requestContextRefresh } from "./contextProjection";

const fingerprint = (project: string, title: string) =>
  `${project.trim().toLowerCase()}:${title.trim().toLowerCase().replace(/\s+/g, " ")}`.slice(0, 240);

export const upsertGoal = mutation({
  args: {
    project: v.string(),
    title: v.string(),
    outcome: v.string(),
    status: v.optional(v.string()),
    priority: v.optional(v.number()),
    progress: v.optional(v.number()),
    nextAction: v.optional(v.string()),
    blockedBy: v.optional(v.string()),
    evidence: v.optional(v.array(v.string())),
    owner: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const key = fingerprint(a.project, a.title);
    const existing = await ctx.db
      .query("projectGoals")
      .withIndex("by_fingerprint", (q: any) => q.eq("fingerprint", key))
      .first();
    const now = Date.now();
    const doc = {
      fingerprint: key,
      project: a.project.trim().toLowerCase().slice(0, 80),
      title: a.title.trim().slice(0, 160),
      outcome: a.outcome.trim().slice(0, 1_200),
      status: (a.status ?? existing?.status ?? "active").slice(0, 30),
      priority: Math.round(Math.max(0, Math.min(100, a.priority ?? existing?.priority ?? 60))),
      progress: Math.round(Math.max(0, Math.min(100, a.progress ?? existing?.progress ?? 0))),
      nextAction: a.nextAction?.trim().slice(0, 600) ?? existing?.nextAction,
      blockedBy: a.blockedBy?.trim().slice(0, 600) ?? existing?.blockedBy,
      evidence: (a.evidence ?? existing?.evidence ?? []).map((item) => item.slice(0, 400)).slice(0, 20),
      owner: a.owner?.trim().slice(0, 80) ?? existing?.owner,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      await requestContextRefresh(ctx, ["projects"]);
      return existing._id;
    }
    const id = await ctx.db.insert("projectGoals", { ...doc, createdAt: now });
    await requestContextRefresh(ctx, ["projects"]);
    return id;
  },
});

export const listGoals = query({
  args: { project: v.optional(v.string()), status: v.optional(v.string()), limit: v.optional(v.number()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const limit = Math.min(80, Math.max(1, a.limit ?? 40));
    let rows;
    if (a.project && a.status) {
      rows = await ctx.db
        .query("projectGoals")
        .withIndex("by_project_status", (q: any) => q.eq("project", a.project!.toLowerCase()).eq("status", a.status!))
        .take(limit);
    } else {
      rows = await ctx.db.query("projectGoals").withIndex("by_updatedAt").order("desc").take(limit);
      if (a.project) rows = rows.filter((row) => row.project === a.project!.toLowerCase());
      if (a.status) rows = rows.filter((row) => row.status === a.status);
    }
    return rows.sort((left, right) => right.priority - left.priority || right.updatedAt - left.updatedAt);
  },
});

export const portfolio = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const [projects, active, blocked] = await Promise.all([
      ctx.db.query("projectState").collect(),
      ctx.db
        .query("projectGoals")
        .withIndex("by_status_priority", (q: any) => q.eq("status", "active"))
        .order("desc")
        .take(50),
      ctx.db
        .query("projectGoals")
        .withIndex("by_status_priority", (q: any) => q.eq("status", "blocked"))
        .order("desc")
        .take(30),
    ]);
    return projects.map((project) => ({
      ...project,
      goals: [...active, ...blocked]
        .filter((goal) => goal.project === project.slug)
        .sort((left, right) => right.priority - left.priority),
    }));
  },
});
