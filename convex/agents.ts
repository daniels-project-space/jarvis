import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { actorAuthArgs, requireActor, requireViewer, viewerAuthArgs } from "./controlAuth";

const TEAM = [
  {
    slug: "jarvis",
    name: "JARVIS",
    role: "Chief of Staff & Supervisor",
    description: "Owns the conversation, chooses the right specialist, reviews outcomes, and keeps Daniel's attention queue small.",
    capabilities: ["planning", "delegation", "attention-triage", "review", "conversation"],
    projectScopes: ["*"],
    defaultModel: "sol",
    autonomy: "supervised",
  },
  {
    slug: "paul",
    name: "Paul",
    role: "Principal Developer",
    description: "Builds, debugs, tests, and reviews software across Daniel's project estate using isolated branches.",
    capabilities: ["engineering", "architecture", "debugging", "testing", "deployment-review"],
    projectScopes: ["*"],
    defaultModel: "sol",
    autonomy: "branch-only",
  },
  {
    slug: "atlas",
    name: "Atlas",
    role: "Research & Strategy Lead",
    description: "Researches primary sources, compares options, challenges assumptions, and turns ambiguity into decisions.",
    capabilities: ["research", "strategy", "analysis", "brainstorming", "fact-checking"],
    projectScopes: ["*"],
    defaultModel: "terra",
    autonomy: "read-only",
  },
  {
    slug: "iris",
    name: "Iris",
    role: "Creative Director",
    description: "Turns ideas into visual systems, illustrations, storyboards, diagrams, and polished creative briefs.",
    capabilities: ["illustration", "design", "storyboarding", "diagramming", "creative-direction"],
    projectScopes: ["media-engine", "music-house", "youtube-studio-ai", "*"],
    defaultModel: "terra",
    autonomy: "draft-only",
  },
  {
    slug: "maya",
    name: "Maya",
    role: "Travel Planner",
    description: "Builds progressive, visual trip plans while keeping booking and calendar commitments explicitly gated.",
    capabilities: ["travel", "flights", "stays", "itineraries", "maps"],
    projectScopes: ["jarvis"],
    defaultModel: "terra",
    autonomy: "draft-only",
  },
  {
    slug: "sentry",
    name: "Sentry",
    role: "Reliability & Review Lead",
    description: "Monitors projects and agent runs, verifies evidence, retries recoverable failures, and escalates real blockers.",
    capabilities: ["operations", "monitoring", "verification", "incident-response", "cost-awareness"],
    projectScopes: ["*"],
    defaultModel: "terra",
    autonomy: "safe-auto-fix",
  },
] as const;

export const seed = mutation({
  args: { ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    let created = 0;
    let updated = 0;
    for (const member of TEAM) {
      const existing = await ctx.db
        .query("agentProfiles")
        .withIndex("by_slug", (q: any) => q.eq("slug", member.slug))
        .first();
      const stable = {
        ...member,
        capabilities: [...member.capabilities],
        projectScopes: [...member.projectScopes],
        updatedAt: Date.now(),
      };
      if (existing) {
        await ctx.db.patch(existing._id, stable);
        updated += 1;
      } else {
        await ctx.db.insert("agentProfiles", {
          ...stable,
          status: "available",
          completedJobs: 0,
          failedJobs: 0,
        });
        created += 1;
      }
    }
    return { created, updated, total: TEAM.length };
  },
});

export const list = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const statuses = ["running", "pending", "awaiting_approval", "paused", "needs_input"];
    const [profiles, groups] = await Promise.all([
      ctx.db.query("agentProfiles").collect(),
      Promise.all(
        statuses.map((status) =>
          ctx.db
            .query("jobs")
            .withIndex("by_status", (q: any) => q.eq("status", status))
            .take(30),
        ),
      ),
    ]);
    const jobs = groups.flat();
    return profiles
      .map((profile) => {
        const owned = jobs.filter((job) => job.agentId === profile.slug);
        const executing = owned.find((job) => job.status === "running" || job.status === "pending");
        const blocked = owned.find((job) => ["needs_input", "paused", "awaiting_approval"].includes(job.status));
        return {
          ...profile,
          status: executing ? "working" : blocked ? "blocked" : "available",
          currentJobId: executing ? String(executing._id) : blocked ? String(blocked._id) : undefined,
          activeJobIds: owned.map((job) => String(job._id)),
          activeJobCount: owned.length,
        };
      })
      .sort((a: any, b: any) => (a.slug === "jarvis" ? -1 : b.slug === "jarvis" ? 1 : a.name.localeCompare(b.name)));
  },
});

export const setWork = mutation({
  args: {
    slug: v.string(),
    status: v.string(),
    currentJobId: v.optional(v.string()),
    ...actorAuthArgs,
  },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db
      .query("agentProfiles")
      .withIndex("by_slug", (q: any) => q.eq("slug", a.slug))
      .first();
    if (!row) return false;
    await ctx.db.patch(row._id, {
      status: a.status,
      currentJobId: a.currentJobId,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const recordOutcome = mutation({
  args: { slug: v.string(), success: v.boolean(), durationMs: v.number(), ...actorAuthArgs },
  handler: async (ctx, a) => {
    await requireActor(ctx, a);
    const row = await ctx.db
      .query("agentProfiles")
      .withIndex("by_slug", (q: any) => q.eq("slug", a.slug))
      .first();
    if (!row) return false;
    const previousRuns = row.completedJobs + row.failedJobs;
    const averageDurationMs = Math.round(
      ((row.averageDurationMs ?? a.durationMs) * previousRuns + a.durationMs) / Math.max(1, previousRuns + 1),
    );
    await ctx.db.patch(row._id, {
      completedJobs: row.completedJobs + (a.success ? 1 : 0),
      failedJobs: row.failedJobs + (a.success ? 0 : 1),
      averageDurationMs,
      status: "available",
      currentJobId: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
