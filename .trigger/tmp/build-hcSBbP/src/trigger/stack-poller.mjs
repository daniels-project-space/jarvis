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

// src/trigger/stack-poller.ts
init_esm();
var CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
var VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";
var VERCEL_TEAM = "team_VY2PwHgXLV9Bo0vs2iXdnGxw";
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
async function vaultService(service) {
  const r = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" })
  });
  const rows = (await r.json()).value ?? [];
  return Object.fromEntries(rows.map((x) => [x.keyName, x.value]));
}
__name(vaultService, "vaultService");
var stackPoller = schedules_exports.task({
  id: "jarvis-stack-poller",
  cron: "*/15 * * * *",
  maxDuration: 300,
  run: /* @__PURE__ */ __name(async () => {
    const token = (await vaultService("vercel")).VERCEL_TOKEN;
    if (!token) return { polled: 0, error: "no vercel token" };
    const prior = await convexQuery("projectState:list", {}) ?? [];
    const priorStatus = new Map(prior.map((s) => [s.slug, s.status]));
    const H = { authorization: `Bearer ${token}` };
    const res = await fetch(`https://api.vercel.com/v9/projects?teamId=${VERCEL_TEAM}&limit=100`, { headers: H });
    const projects = (await res.json()).projects ?? [];
    let polled = 0;
    const newlyBroken = [];
    for (const p of projects) {
      const prod = p.targets?.production;
      const status = prod?.readyState ?? "no-deploy";
      const alias = (prod?.alias ?? []).find((a) => !a.includes("-danielmabro")) ?? (prod?.alias ?? [])[0];
      const old = priorStatus.get(p.name);
      if (status === "ERROR" && old && old !== "ERROR") newlyBroken.push(p.name);
      await convexMutation("projectState:upsert", {
        slug: p.name,
        status,
        summary: `Vercel: ${status}${alias ? ` · ${alias}` : ""}`,
        data: { vercel: status, url: alias ? `https://${alias}` : null, framework: p.framework ?? null }
      });
      polled++;
    }
    if (newlyBroken.length) {
      await convexMutation("chatQueue:postAssistant", {
        threadId: "main",
        text: `⚠️ Heads up, sir — a deploy just failed: ${newlyBroken.join(", ")}. Shall I dispatch an agent to investigate?`
      });
      await sendPush("⚠️ Deploy failed", `${newlyBroken.join(", ")} — tap to open JARVIS.`, "/");
    }
    return { polled, newlyBroken };
  }, "run")
});
export {
  stackPoller
};
//# sourceMappingURL=stack-poller.mjs.map
