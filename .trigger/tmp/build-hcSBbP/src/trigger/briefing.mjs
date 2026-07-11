import {
  sendPush
} from "../../chunk-BOIXZMYY.mjs";
import {
  schedules_exports
} from "../../chunk-UWUGKQYD.mjs";
import "../../chunk-35EY4FVJ.mjs";
import "../../chunk-63QJXTJT.mjs";
import "../../chunk-KCQUMA6A.mjs";
import "../../chunk-NIYKPRZ7.mjs";
import "../../chunk-5F2UBCFF.mjs";
import {
  __name,
  init_esm
} from "../../chunk-J4P35T43.mjs";

// src/trigger/briefing.ts
init_esm();
var CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
async function convexMutation(path, args) {
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" })
  }).catch(() => {
  });
}
__name(convexMutation, "convexMutation");
async function convexQuery(path, args) {
  try {
    return (await (await fetch(`${CONVEX_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" })
    })).json()).value;
  } catch {
    return null;
  }
}
__name(convexQuery, "convexQuery");
var morningBriefing = schedules_exports.task({
  id: "jarvis-morning-briefing",
  cron: "0 7 * * *",
  // ~07:00 UTC daily
  maxDuration: 120,
  run: /* @__PURE__ */ __name(async () => {
    const stack = await convexQuery("projectState:list", {}) ?? [];
    const broken = stack.filter((s) => s.status === "ERROR").map((s) => s.slug);
    const live = stack.filter((s) => s.status === "READY").length;
    const jobs = await convexQuery("jobs:list", { limit: 8 }) ?? [];
    const doneJobs = jobs.filter((j) => j.status === "done").length;
    const lines = [
      "☀️ Morning, sir.",
      broken.length ? `⚠️ ${broken.length} app${broken.length > 1 ? "s" : ""} need attention: ${broken.join(", ")}.` : `All ${live} deploys are green.`,
      `${live}/${stack.length} deploys healthy${doneJobs ? ` · ${doneJobs} background job${doneJobs > 1 ? "s" : ""} completed` : ""}.`
    ];
    await convexMutation("chatQueue:postAssistant", { threadId: "main", text: lines.join("\n") });
    await sendPush("☀️ Morning briefing", lines.slice(1).join(" "), "/");
    return { posted: true, broken };
  }, "run")
});
export {
  morningBriefing
};
//# sourceMappingURL=briefing.mjs.map
