import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

const allowedSources = new Set([
  "projects",
  "agents",
  "attention",
  "watches",
  "findings",
  "reminders",
  "business:rental",
  "business:youtube",
  "business:wealth",
  "business:music",
  "business:ads",
]);

// One scene-level subscription resolves every live block on screen. Sources
// are allowlisted and demand-driven so a rental card does not also subscribe
// to projects, agent logs, watches and every other domain.
export const snapshot = query({
  args: { sources: v.array(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const sources = [...new Set(a.sources.filter((source) => allowedSources.has(source)))].slice(0, 12);
    const wants = (source: string) => sources.includes(source);
    const businessDomains = sources
      .filter((source) => source.startsWith("business:"))
      .map((source) => source.slice("business:".length));

    const activeStatuses = ["running", "pending", "awaiting_approval", "paused", "needs_input"];
    const [projects, goalGroups, agentProfiles, jobGroups, missionGroups, attention, watches, watchEvents, findings, reminders, business] =
      await Promise.all([
        wants("projects") ? ctx.db.query("projectState").collect() : [],
        wants("projects")
          ? Promise.all(
              ["active", "blocked"].map((status) =>
                ctx.db
                  .query("projectGoals")
                  .withIndex("by_status_priority", (q: any) => q.eq("status", status))
                  .order("desc")
                  .take(30),
              ),
            )
          : [],
        wants("agents") ? ctx.db.query("agentProfiles").collect() : [],
        wants("agents")
          ? Promise.all(
              activeStatuses.map((status) =>
                ctx.db.query("jobs").withIndex("by_status", (q: any) => q.eq("status", status)).take(16),
              ),
            )
          : [],
        wants("agents")
          ? Promise.all(
              ["running", "synthesizing"].map((status) =>
                ctx.db.query("missions").withIndex("by_status", (q: any) => q.eq("status", status)).take(12),
              ),
            )
          : [],
        wants("attention")
          ? ctx.db
              .query("attentionItems")
              .withIndex("by_status", (q: any) => q.eq("status", "open"))
              .order("desc")
              .take(24)
          : [],
        wants("watches")
          ? ctx.db.query("watchRules").withIndex("by_status_nextCheckAt", (q: any) => q.eq("status", "active")).take(40)
          : [],
        wants("watches")
          ? ctx.db
              .query("watchEvents")
              .withIndex("by_status_createdAt", (q: any) => q.eq("status", "open"))
              .order("desc")
              .take(20)
          : [],
        wants("findings") ? ctx.db.query("findings").withIndex("by_createdAt").order("desc").take(30) : [],
        wants("reminders")
          ? ctx.db
              .query("reminders")
              .withIndex("by_status", (q: any) => q.eq("status", "pending"))
              .order("asc")
              .take(30)
          : [],
        Promise.all(
          businessDomains.map((domain) =>
            ctx.db.query("businessState").withIndex("by_domain", (q: any) => q.eq("domain", domain)).first(),
          ),
        ),
      ]);

    const jobs = Array.isArray(jobGroups) ? jobGroups.flat() : [];
    const missions = Array.isArray(missionGroups) ? missionGroups.flat() : [];
    const liveAgents = agentProfiles.map((profile: any) => {
      const owned = jobs.filter((job: any) => job.agentId === profile.slug);
      const current = owned.find((job: any) => job.status === "running" || job.status === "pending") ?? owned[0];
      return {
        slug: profile.slug,
        name: profile.name,
        role: profile.role,
        status: current ? (current.status === "running" || current.status === "pending" ? "working" : "blocked") : "available",
        currentJobId: current ? String(current._id) : undefined,
        activeJobIds: owned.map((job: any) => String(job._id)),
        activeJobCount: owned.length,
        completedJobs: profile.completedJobs,
        failedJobs: profile.failedJobs,
        updatedAt: profile.updatedAt,
      };
    });

    return {
      sources,
      projects: projects.map((project: any) => ({
        slug: project.slug,
        status: project.status,
        summary: project.summary,
        data: project.data,
        goals: (Array.isArray(goalGroups) ? goalGroups.flat() : [])
          .filter((goal: any) => goal.project === project.slug)
          .map((goal: any) => ({
            id: String(goal._id), title: goal.title, outcome: goal.outcome, status: goal.status,
            priority: goal.priority, progress: goal.progress, nextAction: goal.nextAction, blockedBy: goal.blockedBy,
          })),
        updatedAt: project.updatedAt,
      })),
      agents: liveAgents,
      jobs: jobs
        .sort((left: any, right: any) => (right.priority ?? 50) - (left.priority ?? 50))
        .slice(0, 40)
        .map((job: any) => ({
          id: String(job._id),
          agentId: job.agentId,
          label: job.label,
          task: job.task,
          status: job.status,
          stage: job.stage,
          percent: job.percent,
          progress: job.progress,
          priority: job.priority,
          heartbeatAt: job.heartbeatAt,
          startedAt: job.startedAt,
        })),
      missions: missions.map((mission: any) => ({
        id: String(mission._id),
        goal: mission.goal,
        status: mission.status,
        phase: mission.phase,
        percent: mission.percent,
        updatedAt: mission.updatedAt,
      })),
      attention: attention
        .sort(
          (left: any, right: any) =>
            right.impact * right.urgency * right.confidence - left.impact * left.urgency * left.confidence,
        )
        .map((item: any) => ({
          id: String(item._id),
          project: item.project,
          title: item.title,
          detail: item.detail,
          severity: item.severity,
          impact: item.impact,
          urgency: item.urgency,
          confidence: item.confidence,
          actionClass: item.actionClass,
          updatedAt: item.updatedAt,
        })),
      watches: watches.map((watch: any) => ({
        id: String(watch._id),
        kind: watch.kind,
        label: watch.label,
        definition: watch.definition,
        lastObservation: watch.lastObservation,
        nextCheckAt: watch.nextCheckAt,
        lastTriggeredAt: watch.lastTriggeredAt,
        failureCount: watch.failureCount,
        lastError: watch.lastError,
        updatedAt: watch.updatedAt,
        createdAt: watch.createdAt,
      })),
      watchEvents: watchEvents.map((event: any) => ({
        id: String(event._id),
        watchId: String(event.watchId),
        title: event.title,
        spoken: event.spoken,
        detail: event.detail,
        reason: event.reason,
        observation: event.observation,
        glowUntil: event.glowUntil,
        createdAt: event.createdAt,
      })),
      findings: findings.map((finding: any) => ({
        id: String(finding._id),
        source: finding.source,
        spoken: finding.spoken,
        detail: finding.detail,
        bullets: finding.bullets,
        important: finding.important,
        status: finding.status,
        createdAt: finding.createdAt,
      })),
      reminders: reminders.map((reminder: any) => ({
        id: String(reminder._id),
        text: reminder.text,
        at: reminder.at,
        createdAt: reminder.createdAt,
      })),
      business: Object.fromEntries(
        business
          .filter(Boolean)
          .map((row: any) => [
            row.domain,
            { headline: row.headline, detail: row.detail, data: row.data, updatedAt: row.updatedAt },
          ]),
      ),
      generatedAt: Date.now(),
    };
  },
});
