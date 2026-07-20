import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";
import { runtimeJob } from "./controlPlane";

// The top work pill intentionally has a tiny data contract. Project health,
// watches, team rosters, missions and history each have dedicated visual
// surfaces; subscribing to all of them here multiplied Convex reads and made
// routine background changes flicker in the conversation UI.
export const snapshot = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const groups = await Promise.all([
      // Routine maintenance is never fetched into the live conversation strip
      // in the first place; client filtering remains a compatibility backstop.
      ctx.db
        .query("jobRuntime")
        .withIndex("by_visibility_status_priority", (q: any) => q.eq("visibility", "conversation").eq("status", "running"))
        .order("desc")
        .take(12),
      ctx.db
        .query("jobRuntime")
        .withIndex("by_visibility_status_priority", (q: any) => q.eq("visibility", "conversation").eq("status", "dispatching"))
        .order("desc")
        .take(12),
      ctx.db.query("jobRuntime").withIndex("by_status_priority", (q: any) => q.eq("status", "awaiting_approval")).order("desc").take(12),
      ctx.db.query("jobRuntime").withIndex("by_status_priority", (q: any) => q.eq("status", "needs_input")).order("desc").take(12),
    ]);
    return {
      active: groups
        .flat()
        .sort((x: any, y: any) => (y.priority ?? 50) - (x.priority ?? 50) || x.createdAt - y.createdAt)
        .map(runtimeJob),
    };
  },
});
