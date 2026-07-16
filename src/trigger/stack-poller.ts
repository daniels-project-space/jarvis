import { schedules } from "@trigger.dev/sdk/v3";
import { sendPush } from "./push-send";

// Slice C — awareness. Polls the cloud stack (Vercel deploy health across all of
// Daniel's apps) and writes a snapshot to Convex `projectState`, which the brain
// injects each turn so JARVIS can answer "what's the state of my apps / anything broken?".

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";
const VERCEL_TEAM = "team_VY2PwHgXLV9Bo0vs2iXdnGxw";

async function convexMutation(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  const protectedPath = path === "chatQueue:postAssistant" || path === "incidents:report";
  if (protectedPath && !workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const protectedArgs = protectedPath
    ? { ...((args ?? {}) as Record<string, unknown>), workerToken }
    : args;
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
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
async function vaultService(service: string): Promise<Record<string, string>> {
  const r = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
  });
  const rows = ((await r.json()).value ?? []) as Array<{ keyName: string; value: string }>;
  return Object.fromEntries(rows.map((x) => [x.keyName, x.value]));
}


async function chatThread(): Promise<string> {
  try {
    const r = await fetch(`${CONVEX_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "ui:getActiveThread", args: {}, format: "json" }),
    });
    const t = (await r.json()).value;
    return typeof t === "string" && t ? t : "main";
  } catch {
    return "main";
  }
}

export const stackPoller = schedules.task({
  id: "jarvis-stack-poller",
  cron: "*/15 * * * *",
  maxDuration: 300,
  run: async () => {
    const token = (await vaultService("vercel")).VERCEL_TOKEN;
    if (!token) return { polled: 0, error: "no vercel token" };
    const prior: any[] = (await convexQuery("projectState:list", {})) ?? [];
    const priorStatus = new Map<string, string>(prior.map((s: any) => [s.slug, s.status]));
    const H = { authorization: `Bearer ${token}` };
    const res = await fetch(`https://api.vercel.com/v9/projects?teamId=${VERCEL_TEAM}&limit=100`, { headers: H });
    const projects: any[] = (await res.json()).projects ?? [];
    // "What's new" awareness: latest commit per app repo so JARVIS knows what
    // changed across the dashboard, not just whether deploys are green.
    const gh = process.env.GITHUB_TOKEN ?? "";
    async function latestCommit(repo: string): Promise<string> {
      if (!gh) return "";
      try {
        const r = await fetch(`https://api.github.com/repos/daniels-project-space/${repo}/commits?per_page=1`, {
          headers: { Authorization: `Bearer ${gh}`, Accept: "application/vnd.github+json" },
        });
        if (!r.ok) return "";
        const c = (await r.json())[0];
        const when = new Date(c.commit.author.date);
        const hrs = Math.max(0, Math.round((Date.now() - when.getTime()) / 3_600_000));
        const msg = String(c.commit.message).split("\n")[0].slice(0, 80);
        return `latest change ${hrs < 1 ? "under an hour" : hrs < 48 ? `${hrs}h` : `${Math.round(hrs / 24)}d`} ago: "${msg}"`;
      } catch {
        return "";
      }
    }

    let polled = 0;
    const newlyBroken: string[] = [];
    for (const p of projects) {
      const prod = p.targets?.production;
      const status = prod?.readyState ?? "no-deploy";
      const alias = (prod?.alias ?? []).find((a: string) => !a.includes("-danielmabro")) ?? (prod?.alias ?? [])[0];
      const old = priorStatus.get(p.name);
      if (status === "ERROR" && old && old !== "ERROR") newlyBroken.push(p.name);
      const recent = await latestCommit(p.name);
      await convexMutation("projectState:upsert", {
        slug: p.name,
        status,
        summary: `Vercel: ${status}${alias ? ` · ${alias}` : ""}${recent ? ` · ${recent}` : ""}`,
        data: { vercel: status, url: alias ? `https://${alias}` : null, framework: p.framework ?? null, recent },
      });
      polled++;
    }
    // Self-healing: a newly-broken deploy files an incident (the healer
    // dispatches a root-cause repair agent within ~2 min) and tells Daniel.
    if (newlyBroken.length) {
      for (const app of newlyBroken)
        await convexMutation("incidents:report", {
          source: "stack-poller",
          app,
          signature: `deploy-failed:${app}`,
          message: `Vercel production deploy for ${app} is in ERROR state.`,
        });
      await convexMutation("chatQueue:postAssistant", {
        threadId: await chatThread(),
        text: `Heads up, sir — ${newlyBroken.join(" and ")} just failed to deploy. I'm sending an engineer in to trace it and fix it now.`,
      });
      await sendPush("⚠️ Deploy failed", `${newlyBroken.join(", ")} — repair agent dispatched.`, "/");
    }
    return { polled, newlyBroken };
  },
});
