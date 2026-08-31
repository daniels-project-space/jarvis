import { schedules } from "@trigger.dev/sdk/v3";

// Daily low-cost summary calculation. Routine health status stays available to
// Jarvis and the work surfaces, but never interrupts Daniel through chat/push.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function convexQuery(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  try {
    return (
      await (
        await fetch(`${CONVEX_URL}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args: { ...((args ?? {}) as Record<string, unknown>), workerToken }, format: "json" }),
        })
      ).json()
    ).value;
  } catch {
    return null;
  }
}

export const morningBriefing = schedules.task({
  id: "jarvis-morning-briefing",
  cron: "0 7 * * *", // ~07:00 UTC daily
  maxDuration: 120,
  run: async () => {
    const stack: any[] = (await convexQuery("projectState:list", {})) ?? [];
    const broken = stack.filter((s) => s.status === "ERROR").map((s) => s.slug);
    const live = stack.filter((s) => s.status === "READY").length;
    const jobs: any[] = (await convexQuery("jobs:list", { limit: 8 })) ?? [];
    const doneJobs = jobs.filter((j) => j.status === "done").length;

    return { posted: false, broken, live, total: stack.length, doneJobs };
  },
});
