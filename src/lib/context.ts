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

export async function buildContext(userText?: string): Promise<{ block: string; freshFindingIds: string[] }> {
  const [memHit, memRecent, biz, stack, todos, events, wealth, jobs, findings] = await Promise.all([
    userText ? q(CONVEX_URL, "memory:search", { q: userText, limit: 8 }) : null,
    q(CONVEX_URL, "memory:recent", { limit: 6 }),
    q(CONVEX_URL, "business:list", {}),
    q(CONVEX_URL, "projectState:list", {}),
    q(HUB_URL, "todos:list"),
    q(HUB_URL, "events:list"),
    q(HUB_URL, "wealth:getWealth"),
    q(CONVEX_URL, "jobs:active", {}),
    q(CONVEX_URL, "findings:fresh", {}),
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
    lines.push("Cloud stack: " + stack.map((s: any) => `${s.slug}=${s.status}`).join(", "));
  if (Array.isArray(jobs) && jobs.length)
    lines.push("Agents working right now: " + jobs.map((j: any) => `"${j.task.slice(0, 80)}" (${j.status})`).join("; "));
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
