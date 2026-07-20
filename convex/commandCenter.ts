import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireViewer, viewerAuthArgs } from "./controlAuth";

export type CompactConversationWork = {
  id: string;
  label: string;
  status: "dispatching" | "running";
  stage: string;
  percent: number;
};

type RuntimeRow = {
  jobId?: unknown;
  task?: unknown;
  label?: unknown;
  status?: unknown;
  visibility?: unknown;
  originThreadId?: unknown;
  stage?: unknown;
  percent?: unknown;
  priority?: unknown;
  createdAt?: unknown;
};

export const COMPACT_WORK_STATUSES = ["running", "dispatching"] as const;

const HEALTH_CHECK_WORK = /\b(?:health[ -]?(?:check|audit)|cloud health audit|heartbeat|uptime poll|stack poll|polling sweep|sentry sweep|provider health|background check|routine monitor)\b/i;

function isCurrentConversationWork(row: RuntimeRow, threadId: string): boolean {
  const status = String(row.status ?? "");
  if (status !== "running" && status !== "dispatching") return false;
  if (row.visibility !== "conversation" || row.originThreadId !== threadId) return false;
  return !HEALTH_CHECK_WORK.test([row.label, row.task, row.stage].filter(Boolean).join(" "));
}

function compactWork(row: RuntimeRow): CompactConversationWork {
  const status = row.status === "dispatching" ? "dispatching" : "running";
  return {
    id: String(row.jobId),
    label: String(row.label ?? row.task ?? "Active work").slice(0, 80),
    status,
    stage: String(row.stage ?? status).slice(0, 80),
    percent: Math.max(0, Math.min(100, Number(row.percent ?? 0))),
  };
}

// Keep selection defensive even though the indexed reads below already fence
// visibility, thread and status. A malformed or legacy projection must never
// widen this compact conversation-only contract.
export function selectCompactConversationWork(
  rows: readonly RuntimeRow[],
  threadId: string,
): CompactConversationWork | null {
  const selected = rows
    .filter((row) => isCurrentConversationWork(row, threadId))
    .sort((left, right) =>
      Number(right.priority ?? 50) - Number(left.priority ?? 50)
      || Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
    )[0];
  return selected ? compactWork(selected) : null;
}

// This subscription is deliberately singular and tiny. Operations health,
// attention, approvals, missions and rich job details have dedicated queries
// and must never be folded into the top conversation work bar.
export const snapshot = query({
  args: { threadId: v.optional(v.string()), ...viewerAuthArgs },
  returns: v.object({
    active: v.union(
      v.null(),
      v.object({
        id: v.string(),
        label: v.string(),
        status: v.union(v.literal("dispatching"), v.literal("running")),
        stage: v.string(),
        percent: v.number(),
      }),
    ),
  }),
  handler: async (ctx, a) => {
    await requireViewer(ctx, a);
    let threadId = a.threadId?.trim();
    if (a.threadId === undefined) {
      // Browser tabs can outlive a Vercel rollout. Callers loaded before the
      // snapshot became thread-scoped must follow the same canonical thread,
      // never fall back to a cross-conversation view.
      const activeThread = await ctx.db
        .query("ui")
        .withIndex("by_key", (q) => q.eq("key", "activeThread"))
        .first();
      threadId = activeThread?.value.trim() || "main";
    }
    if (!threadId) return { active: null };

    const groups = await Promise.all(
      COMPACT_WORK_STATUSES.map((status) =>
        ctx.db
          .query("jobRuntime")
          .withIndex("by_visibility_status_priority", (q) =>
            q.eq("visibility", "conversation").eq("status", status),
          )
          .filter((q) => q.eq(q.field("originThreadId"), threadId))
          .order("desc")
          .take(12),
      ),
    );

    return { active: selectCompactConversationWork(groups.flat(), threadId) };
  },
});
