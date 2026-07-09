import { schedules } from "@trigger.dev/sdk/v3";

// Slice C — awareness. Polls the cloud stack (Vercel deploy health across all of
// Daniel's apps) and writes a snapshot to Convex `projectState`, which the brain
// injects each turn so JARVIS can answer "what's the state of my apps / anything broken?".

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";
const VERCEL_TEAM = "team_VY2PwHgXLV9Bo0vs2iXdnGxw";

async function convexMutation(path: string, args: unknown) {
  await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).catch(() => {});
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

export const stackPoller = schedules.task({
  id: "jarvis-stack-poller",
  cron: "*/15 * * * *",
  maxDuration: 300,
  run: async () => {
    const token = (await vaultService("vercel")).VERCEL_TOKEN;
    if (!token) return { polled: 0, error: "no vercel token" };
    const H = { authorization: `Bearer ${token}` };
    const res = await fetch(`https://api.vercel.com/v9/projects?teamId=${VERCEL_TEAM}&limit=100`, { headers: H });
    const projects: any[] = (await res.json()).projects ?? [];
    let polled = 0;
    for (const p of projects) {
      const prod = p.targets?.production;
      const status = prod?.readyState ?? "no-deploy";
      const alias = (prod?.alias ?? []).find((a: string) => !a.includes("-danielmabro")) ?? (prod?.alias ?? [])[0];
      await convexMutation("projectState:upsert", {
        slug: p.name,
        status,
        summary: `Vercel: ${status}${alias ? ` · ${alias}` : ""}`,
        data: { vercel: status, url: alias ? `https://${alias}` : null, framework: p.framework ?? null },
      });
      polled++;
    }
    return { polled };
  },
});
