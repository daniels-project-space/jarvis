import "server-only";

// Server-side context bundle for the brain: memory, business intel, hub
// (to-dos/calendar/wealth), cloud stack, running agents, fresh findings.
// Used by /api/chat (every turn) and /api/realtime-token (session start).

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const HUB_URL = "https://fantastic-roadrunner-485.convex.cloud";

async function q(base: string, path: string, args: unknown = {}): Promise<any> {
  try {
    const r = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return (await r.json()).value;
  } catch {
    return null;
  }
}

export async function convexMutation(path: string, args: unknown): Promise<any> {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(j.errorMessage ?? "convex mutation failed");
  return j.value;
}

export const convexQuery = (path: string, args: unknown = {}) => q(CONVEX_URL, path, args);

// Self-healing hook: anything server-side that breaks files an incident; the
// healer (agent-runner) turns open incidents into root-cause repair agents.
export async function reportIncident(source: string, signature: string, message: string, app?: string) {
  try {
    await convexMutation("incidents:report", { source, signature, message, app });
  } catch {
    /* never let telemetry break the caller */
  }
}

export async function buildContext(userText?: string): Promise<{ block: string; freshFindingIds: string[] }> {
  const [memHit, memRecent, biz, stack, todos, events, wealth, jobs, findings, trip] = await Promise.all([
    userText ? q(CONVEX_URL, "memory:search", { q: userText, limit: 8 }) : null,
    q(CONVEX_URL, "memory:recent", { limit: 6 }),
    q(CONVEX_URL, "business:list", {}),
    q(CONVEX_URL, "projectState:list", {}),
    q(HUB_URL, "todos:list"),
    q(HUB_URL, "events:list"),
    q(HUB_URL, "wealth:getWealth"),
    q(CONVEX_URL, "jobs:active", {}),
    q(CONVEX_URL, "findings:fresh", {}),
    q(CONVEX_URL, "creations:latest", { kind: "trip" }),
  ]);

  const mem = [...(Array.isArray(memHit) ? memHit : []), ...(Array.isArray(memRecent) ? memRecent : [])]
    .filter((m: any, i: number, arr: any[]) => arr.findIndex((x: any) => x._id === m._id) === i)
    .slice(0, 10);
  const now = Date.now();
  const openTodos = Array.isArray(todos) ? todos.filter((t: any) => !t.done) : [];
  const upcoming = Array.isArray(events)
    ? events.filter((e: any) => (e.start ?? 0) >= now).sort((a: any, b: any) => a.start - b.start).slice(0, 5)
    : [];

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
    lines.push("Agents working right now: " + jobs.map((j: any) => `"${j.task.slice(0, 80)}" (${j.status})`).join("; "));
  // Current trip: answer questions and lock choices from THIS doc via
  // trip_update — never re-run trip_plan for a trip that's already in flight.
  if (trip?.data && Date.now() - (trip.updatedAt ?? 0) < 14 * 86_400_000) {
    try {
      const t = JSON.parse(trip.data);
      lines.push(
        `TRIP IN PROGRESS (${t.status}): ${t.title}, budget £${t.budgetGbp}, total so far £${t.totals?.total ?? "?"}. ` +
          `Locked: flight ${t.locked?.flight ? `${t.locked.flight.airline} £${t.locked.flight.priceGbp}pp` : "—"}, ` +
          `stay ${t.locked?.stay ? `${t.locked.stay.name} £${t.locked.stay.totalGbp} total` : "—"}, ` +
          `activities: ${(t.locked?.activities ?? []).join(", ") || "—"}` +
          (t.transfer ? `, airport transfer ${t.transfer.durationText}` : "") +
          `. Use trip_update (lock/show/toggle) or trip_finalize on THIS trip; only call trip_plan for a NEW destination or dates.`,
      );
    } catch {
      /* stale doc */
    }
  }
  if (Array.isArray(findings) && findings.length)
    lines.push(
      "FRESH AGENT FINDINGS — weave the relevant one into your reply naturally (one casual sentence, offer detail on screen), don't recite:\n" +
        findings.map((f: any) => `- ${f.spoken}`).join("\n"),
    );

  return {
    block: lines.join("\n\n").slice(0, 6000),
    freshFindingIds: Array.isArray(findings) ? findings.map((f: any) => f._id) : [],
  };
}
