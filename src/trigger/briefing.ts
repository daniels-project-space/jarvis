import { schedules } from "@trigger.dev/sdk/v3";

// Slice F — proactive morning briefing. Composes a rundown from the cloud-stack
// snapshot + recent background jobs and posts it into the chat unprompted.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

async function convexMutation(path: string, args: unknown) {
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).catch(() => {});
}
async function convexQuery(path: string, args: unknown) {
  try {
    return (
      await (
        await fetch(`${CONVEX_URL}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, args, format: "json" }),
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

    const lines = [
      "☀️ Morning, sir.",
      broken.length
        ? `⚠️ ${broken.length} app${broken.length > 1 ? "s" : ""} need attention: ${broken.join(", ")}.`
        : `All ${live} deploys are green.`,
      `${live}/${stack.length} deploys healthy${doneJobs ? ` · ${doneJobs} background job${doneJobs > 1 ? "s" : ""} completed` : ""}.`,
    ];
    await convexMutation("chatQueue:postAssistant", { threadId: "main", text: lines.join("\n") });
    return { posted: true, broken };
  },
});
