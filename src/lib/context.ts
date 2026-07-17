import "server-only";
import { currentAdminSession } from "./control-context";
import { resolveConvexUrl } from "./convex-url";

// Server-side context bundle for the brain: memory, business intel, hub
// (to-dos/calendar/wealth), cloud stack, running agents, fresh findings.
// Used by /api/chat (every turn) and /api/realtime-token (session start).

const CONVEX_URL = resolveConvexUrl(process.env.NEXT_PUBLIC_CONVEX_URL, process.env.CONVEX_URL);
const HUB_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function q(base: string, path: string, args: unknown = {}): Promise<any> {
  try {
    const authTokenHash = base === CONVEX_URL ? currentAdminSession() : null;
    const protectedArgs = authTokenHash
      ? { ...((args ?? {}) as Record<string, unknown>), authTokenHash }
      : args;
    const r = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
    });
    return (await r.json()).value;
  } catch {
    return null;
  }
}

export async function convexMutation(path: string, args: unknown): Promise<any> {
  const authTokenHash = currentAdminSession();
  const protectedArgs = authTokenHash
    ? { ...((args ?? {}) as Record<string, unknown>), authTokenHash }
    : args;
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(j.errorMessage ?? "convex mutation failed");
  return j.value;
}

export const convexQuery = (path: string, args: unknown = {}) => q(CONVEX_URL, path, args);

// Self-healing hook: anything server-side that breaks files an incident; the
// healer (agent-runner) turns open incidents into root-cause repair agents.
export async function reportIncident(source: string, signature: string, message: string, app?: string, authTokenHash?: string) {
  try {
    await convexMutation("incidents:report", { source, signature, message, app, authTokenHash });
  } catch {
    /* never let telemetry break the caller */
  }
}

export async function buildContext(
  userText?: string,
  options?: { includeConversation?: boolean },
): Promise<{ block: string; freshFindingIds: string[]; threadId?: string; conversation?: any[] }> {
  const [brain, hub] = await Promise.all([
    q(CONVEX_URL, "brainContext:snapshot", {
      userText: userText?.slice(0, 240) || undefined,
      includeConversation: options?.includeConversation || undefined,
    }),
    q(HUB_URL, "jarvisContext:snapshot"),
  ]);
  const todos = hub?.todos;
  const events = hub?.events;
  const wealth = hub?.wealth;
  const mem = Array.isArray(brain?.memory) ? brain.memory : [];
  const biz = Array.isArray(brain?.business) ? brain.business : [];
  const stack = Array.isArray(brain?.projects) ? brain.projects : [];
  const jobs = Array.isArray(brain?.jobs) ? brain.jobs : [];
  const findings = Array.isArray(brain?.findings) ? brain.findings : [];
  const trip = brain?.trip;
  const draft = brain?.draft;
  const location = brain?.location;
  const panel = brain?.panel;
  const openTodos = Array.isArray(todos) ? todos : [];
  const upcoming = Array.isArray(events) ? events : [];

  const lines: string[] = [];
  if (mem.length) lines.push("Long-term memory:\n" + mem.map((m: any) => `- ${m.title}: ${m.body}`).join("\n"));
  if (Array.isArray(biz) && biz.length)
    lines.push("Businesses right now:\n" + biz.map((b: any) => `- ${b.headline}${b.detail ? " " + b.detail : ""}`).join("\n"));
  lines.push(
    openTodos.length
      ? `His actual to-do list (${openTodos.length} open): ${openTodos.slice(0, 10).map((t: any) => t.text).join("; ")}`
      : "To-do list is clear.",
  );
  if (upcoming.length)
    lines.push("Calendar: " + upcoming.map((e: any) => `${e.title} on ${new Date(e.start).toDateString()}`).join("; "));
  if (wealth && typeof wealth.currentTotalGBP === "number")
    lines.push(`Net worth: about £${Math.round(wealth.currentTotalGBP).toLocaleString("en-GB")}.`);
  if (Array.isArray(stack) && stack.length)
    lines.push(
      "Cloud stack (with what changed recently): " +
        stack
          .map((s: any) => `${s.slug}=${s.status}${s.data?.recent ? ` — ${s.data.recent}` : ""}`)
          .join("; ")
          .slice(0, 1800),
    );
  if (Array.isArray(jobs) && jobs.length)
    lines.push(
      "Permanent team work right now: " +
        jobs
          .map(
            (j: any) =>
              `${j.agentId ?? "agent"}: "${(j.label ?? j.task).slice(0, 70)}" (${j.stage ?? j.status}, ${j.percent ?? 0}%${(j.attempt ?? 1) > 1 ? `, attempt ${j.attempt}` : ""})`,
          )
          .join("; "),
    );
  if (Array.isArray(brain?.agents) && brain.agents.length)
    lines.push(
      "Permanent team: " +
        brain.agents.map((agent: any) => `${agent.name}=${agent.status} (${agent.role})`).join("; "),
    );
  if (Array.isArray(brain?.attention) && brain.attention.length)
    lines.push(
      "RANKED ATTENTION — mention only what materially needs Daniel now; otherwise act or keep quiet:\n" +
        brain.attention
          .slice(0, 6)
          .map(
            (item: any) =>
              `- ${item.title} [impact ${item.impact}, urgency ${item.urgency}, confidence ${Math.round(item.confidence * 100)}%, action ${item.actionClass}] — ${item.detail}`,
          )
          .join("\n"),
    );
  if (Array.isArray(brain?.approvals) && brain.approvals.length)
    lines.push(
      "NEEDS DANIEL — never execute these until explicitly approved: " +
        brain.approvals.map((approval: any) => `${approval.jobId}: ${approval.summary}`).join("; "),
    );
  // Current trip: answer questions and lock choices from THIS doc via
  // trip_update — never re-run trip_plan for a trip that's already in flight.
  if (trip?.data && Date.now() - (trip.updatedAt ?? 0) < 14 * 86_400_000) {
    try {
      const t = JSON.parse(trip.data);
      lines.push(
        `TRIP IN PROGRESS id=${trip._id} (${t.status}): ${t.title}, budget £${t.budgetGbp}, projected total £${t.totals?.projectedTotal ?? t.totals?.total ?? "?"}, locked total £${t.totals?.lockedTotal ?? "?"}. ` +
          `Locked: flight ${t.locked?.flight ? `${t.locked.flight.airline} £${t.locked.flight.priceGbp}pp` : "—"}, ` +
          `stay ${t.locked?.stay ? `${t.locked.stay.name} £${t.locked.stay.totalGbp} total` : "—"}, ` +
          `activities: ${(t.locked?.activities ?? []).join(", ") || "—"}` +
          (t.transfer ? `, airport transfer ${t.transfer.durationText} (${t.transfer.distanceText}, by ${t.transfer.mode})` : "") +
          `. Every trip_update/trip_finalize call MUST pass trip_id ${trip._id}; only call trip_plan for a NEW destination or dates.`,
      );
    } catch {
      /* stale doc */
    }
  }
  // Active draft: "make it longer / warmer / add X" refers to THIS text —
  // the model must revise via the draft tool with the FULL updated content.
  if ((location as any)?.value)
    lines.push(`Daniel's live location: ${(location as any).value}${(location as any).title ? ` (${(location as any).title})` : ""} — for "near me" / local places use places_near (it uses this).`);
  if (draft?.data && Date.now() - (draft.updatedAt ?? 0) < 2 * 3600_000) {
    lines.push(
      `ACTIVE DRAFT "${draft.title}" (on the writing desk — edit requests like "make it longer/shorter/warmer" mean THIS text; revise by calling draft with title "${draft.title}" and the COMPLETE updated text, never weather/other tools):\n---\n${String(draft.data).slice(0, 2500)}\n---`,
    );
  }
  if (Array.isArray(findings) && findings.length)
    lines.push(
      "FRESH AGENT FINDINGS — weave the relevant one into your reply naturally (one casual sentence, offer detail on screen), don't recite:\n" +
        findings.map((f: any) => `- ${f.spoken}`).join("\n"),
    );

  // WHAT'S ON SCREEN right now — so follow-ups can be answered ABOUT it (highlight
  // a tile, extend a bio, keep it up) instead of rebuilding or wrongly closing it.
  if ((panel as any)?.type) {
    const p: any = panel;
    let desc = `ON SCREEN NOW: "${p.title ?? p.type}" (${p.type}). If Daniel's next message is about THIS, keep it up and act on it — never rebuild or hide it.`;
    if (p.type === "widget") {
      try {
        const wd = JSON.parse(p.value);
        if (wd?.kind === "ranking" && Array.isArray(wd.items)) {
          desc =
            `ON SCREEN NOW: a ranking overlay "${wd.title ?? ""}" — ${wd.items.map((it: any) => `#${it.rank} ${it.name}`).join(", ")}. ` +
            `If he asks about one of these (by number, name, position, or "him/that one"), call rank_focus with its number (and a richer bio if you know one) to highlight+expand it — do NOT rebuild the list or open anything else.`;
        } else {
          desc = `ON SCREEN NOW: a ${wd?.kind ?? "widget"} overlay${wd?.title ? ` "${wd.title}"` : ""}. If his next message is about it, act on it; don't needlessly replace it.`;
        }
      } catch {
        /* keep generic desc */
      }
    }
    lines.push(desc);
  }

  return {
    block: lines.join("\n\n").slice(0, 6000),
    freshFindingIds: Array.isArray(findings) ? findings.map((f: any) => f._id) : [],
    threadId: brain?.threadId,
    conversation: Array.isArray(brain?.conversation) ? brain.conversation : undefined,
  };
}
