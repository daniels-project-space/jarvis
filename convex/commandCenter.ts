import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

// The top work pill intentionally has a tiny data contract. Project health,
// watches, team rosters, missions and history each have dedicated visual
// surfaces; subscribing to all of them here multiplied Convex reads and made
// routine background changes flicker in the conversation UI.
export const snapshot = query({
  args: { ...viewerAuthArgs },
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    const visibleStatuses = ["running", "awaiting_approval", "needs_input"];
    const groups = await Promise.all(
      visibleStatuses.map((status) =>
        ctx.db
          .query("jobs")
          .withIndex("by_status", (q: any) => q.eq("status", status))
          .order("asc")
          .take(12),
      ),
    );
    return {
      active: groups
        .flat()
        .sort((x: any, y: any) => (y.priority ?? 50) - (x.priority ?? 50) || x.createdAt - y.createdAt),
    };
  },
});
