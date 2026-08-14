import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

const ACTIVE_TRAVEL_BOOKING_REFERENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const travelText = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

const travelNumber = (value: unknown) => {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};

const travelRow = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * The visible panel is a trusted owner-controlled UI row. Still treat its
 * payload as untrusted input here: a malformed/stale panel must not make an
 * arbitrary draft part of the model context.
 */
function activePanelDraftId(panel: unknown) {
  const row = travelRow(panel);
  if (row.type !== "trip" || typeof row.value !== "string") return "";
  try {
    return travelText(travelRow(JSON.parse(row.value)).draftId, 128);
  } catch {
    return "";
  }
}

function activeTravelSummary(draft: any, activeThreadId: string, now: number) {
  if (!draft || draft.state !== "draft" || draft.threadId !== activeThreadId || draft.expiresAt <= now) return null;
  let data: Record<string, unknown>;
  try {
    data = travelRow(JSON.parse(String(draft.data ?? "")));
  } catch {
    return null;
  }
  if (data.kind !== "trip") return null;
  const destination = travelText(data.destination, 160) || travelText(draft.destination, 160);
  if (!destination) return null;

  const itinerary = Array.isArray(data.itinerary)
    ? data.itinerary.slice(0, 14).flatMap((rawDay) => {
        const day = travelRow(rawDay);
        const date = travelText(day.date, 24);
        if (!date) return [];
        const route = travelRow(day.route);
        const items = Array.isArray(day.items)
          ? day.items.slice(0, 12).flatMap((rawItem) => {
              const item = travelRow(rawItem);
              const title = travelText(item.title, 120);
              return title ? [{
                title,
                time: travelText(item.time, 16),
                kind: travelText(item.kind, 32),
                durationMinutes: travelNumber(item.durationMinutes),
              }] : [];
            })
          : [];
        return [{
          date,
          label: travelText(day.label, 80),
          items,
          route: {
            mode: travelText(route.mode, 32),
            status: travelText(route.status, 32),
            durationSeconds: travelNumber(route.durationSeconds),
            distanceMeters: travelNumber(route.distanceMeters),
          },
        }];
      })
    : [];

  const discoveries = Array.isArray(data.discoveries)
    ? data.discoveries.slice(0, 8).flatMap((rawDiscovery) => {
        const discovery = travelRow(rawDiscovery);
        const city = travelText(discovery.city, 120);
        if (!city) return [];
        const route = travelRow(discovery.route);
        return [{
          city,
          query: travelText(discovery.query, 160),
          itemCount: Array.isArray(discovery.items) ? discovery.items.length : 0,
          route: {
            mode: travelText(route.mode, 32),
            status: travelText(route.status, 32),
            durationSeconds: travelNumber(route.durationSeconds),
            distanceMeters: travelNumber(route.distanceMeters),
          },
        }];
      })
    : [];

  const bookingReferences = Array.isArray(data.bookingReferences)
    ? data.bookingReferences.slice(0, 8).flatMap((rawBooking) => {
        const booking = travelRow(rawBooking);
        const city = travelText(booking.city, 120);
        const location = travelText(booking.location, 260);
        const start = travelNumber(booking.start);
        const end = travelNumber(booking.end ?? booking.start);
        const verifiedAt = travelNumber(booking.verifiedAt);
        if (!city || !location || start === undefined || end === undefined || end < now || verifiedAt === undefined || verifiedAt > now || now - verifiedAt > ACTIVE_TRAVEL_BOOKING_REFERENCE_MAX_AGE_MS) return [];
        return [{
          city,
          title: travelText(booking.title, 160),
          bookingName: travelText(booking.bookingName, 160),
          location,
          start,
          end,
          state: start <= now ? "active" : "upcoming",
          timeZone: travelText(booking.timeZone, 80),
          distanceKm: travelNumber(booking.distanceKm),
          verifiedAt,
        }];
      })
    : [];

  return {
    draftId: String(draft._id),
    title: travelText(data.title, 180) || travelText(draft.title, 180),
    destination,
    departDate: travelText(data.departDate, 24),
    returnDate: travelText(data.returnDate, 24),
    status: travelText(data.status, 32),
    planRevision: travelNumber(data.planRevision) ?? travelNumber(draft.planRevision) ?? 0,
    updatedAt: travelNumber(draft.updatedAt) ?? now,
    itinerary,
    discoveries,
    bookingReferences,
  };
}

// A single bounded snapshot replaces the former 10-call Convex fan-out used
// by every chat and Realtime session. Keep payloads concise: this is model
// context, while full artifacts remain addressable by id.
export const snapshot = query({
  args: { userText: v.optional(v.string()), ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const text = a.userText?.trim().slice(0, 240);
    const activeStatuses = ["running", "pending", "awaiting_approval", "paused", "needs_input"];
    const [memHit, memRecent, currentState, business, projects, activeGroups, findings, trip, draft, location, panel, activeThread, creations, agents, attentionGroups, approvals, goalGroups, missionGoals] =
      await Promise.all([
        text
          ? ctx.db
              .query("memory")
              .withSearchIndex("search_body", (q) => q.search("body", text))
              .take(8)
          : Promise.resolve([]),
        ctx.db.query("memory").withIndex("by_createdAt").order("desc").take(6),
        ctx.db.query("currentState").collect(),
        ctx.db.query("businessState").collect(),
        ctx.db.query("projectState").collect(),
        Promise.all(
          activeStatuses.map((status) =>
            ctx.db
              .query("jobRuntime")
              .withIndex("by_status_priority", (q: any) => q.eq("status", status))
              .take(8),
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
        ctx.db.query("ui").withIndex("by_key", (q: any) => q.eq("key", "activeThread")).first(),
        ctx.db.query("creations").withIndex("by_updatedAt").order("desc").take(12),
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
        ctx.db.query("missionRuntime").withIndex("by_createdAt").order("desc").take(20),
      ]);
    const activeJobs = activeGroups.flat().sort((x: any, y: any) => (y.priority ?? 50) - (x.priority ?? 50));
    const liveAgents = agents.map((profile) => {
      const owned = activeJobs.filter((job: any) => job.agentId === profile.slug);
      const executing = owned.find((job: any) => job.status === "running" || job.status === "pending");
      const blocked = owned.find((job: any) => ["needs_input", "paused", "awaiting_approval"].includes(job.status));
      return {
        ...profile,
        status: executing ? "working" : blocked ? "blocked" : "available",
        currentJobId: executing ? String(executing.jobId) : blocked ? String(blocked.jobId) : undefined,
        activeJobIds: owned.map((job: any) => String(job.jobId)),
        activeJobCount: owned.length,
      };
    });
    const now = Date.now();
    const usableMemory = [...memHit, ...memRecent].filter(
      (row: any, index: number, all: any[]) =>
        (row.expiresAt === undefined || row.expiresAt > now)
        && all.findIndex((candidate: any) => candidate._id === row._id) === index,
    );
    const activeThreadId = travelText(activeThread?.value, 128) || "main";
    const panelDraftId = activePanelDraftId(panel);
    let activeTravel = null;
    if (panelDraftId) {
      try {
        activeTravel = activeTravelSummary(await ctx.db.get(panelDraftId as any), activeThreadId, now);
      } catch {
        // The panel may refer to a legacy creation or malformed id. It is not
        // a reason to fail an otherwise useful foreground context snapshot.
      }
    }
    return {
      currentState: currentState.filter((row) => row.expiresAt > Date.now()),
      memory: usableMemory.slice(0, 10),
      business,
      projects,
      goals: goalGroups.flat().sort((left: any, right: any) => right.priority - left.priority).slice(0, 24),
      goalMissions: missionGoals
        .filter((mission: any) => mission.mode === "goal" && ["running", "paused", "needs_input"].includes(mission.status))
        .slice(0, 8)
        .map((mission: any) => ({
          id: String(mission.missionId),
          goal: mission.goal,
          status: mission.status,
          phase: mission.phase,
          percent: mission.percent,
          route: mission.route,
          revisionWave: mission.revisionWave ?? 0,
          failureReason: mission.failureReason,
          externalStatus: mission.externalStatus,
          externalStage: mission.externalStage,
        })),
      jobs: activeJobs.map((job: any) => ({ ...job, _id: job.jobId })),
      findings,
      trip,
      draft,
      location,
      panel,
      activeTravel,
      creations: creations.map((creation: any) => ({
        id: String(creation._id),
        kind: creation.kind,
        title: creation.title,
        category: creation.category,
        folder: creation.folder,
        project: creation.project,
        inquiry: creation.inquiry,
        updatedAt: creation.updatedAt,
      })),
      agents: liveAgents,
      attention: attentionGroups.flat().sort(
        (x: any, y: any) => y.impact * y.urgency * y.confidence - x.impact * x.urgency * x.confidence,
      ).slice(0, 12),
      approvals,
      generatedAt: Date.now(),
    };
  },
});
