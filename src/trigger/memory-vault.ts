import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { githubGitEnv, githubRepoUrl } from "./git-transport";

// Obsidian memory vault: consolidates JARVIS's memory into a git-backed,
// categorised, wikilinked Obsidian vault (daniels-project-space/jarvis-memory) —
// the durable, browsable source-of-truth. Convex stays the fast recall index.
// This is the "not-cheap" memory: folders + frontmatter + [[links]], not flat KV.

const CONVEX =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const REPO = "daniels-project-space/jarvis-memory";

async function q(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  try {
    return (
      await (
        await fetch(`${CONVEX}/api/query`, {
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
function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    p.stdout.on("data", (d) => (o += d.toString()));
    p.stderr.on("data", (d) => (o += d.toString()));
    p.on("close", (code) => res({ code, out: o }));
    p.on("error", () => res({ code: -1, out: o }));
  });
}
const slug = (s: string) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
const clean = (s: string) => String(s || "").replace(/[*#`_>]/g, "").trim();

export const memoryVault = schedules.task({
  id: "jarvis-memory-vault",
  cron: "17 */6 * * *", // every 6h
  maxDuration: 180,
  run: async () => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { error: "no GITHUB_TOKEN" };
    const dir = "/tmp/vault";
    rmSync(dir, { recursive: true, force: true });
    const url = githubRepoUrl(REPO);
    const env: NodeJS.ProcessEnv = { ...process.env };
    const gitEnv = githubGitEnv(env, token);
    await sh("git", ["clone", "--depth", "1", url, dir], gitEnv);
    if (!existsSync(join(dir, ".git"))) return { error: "clone failed" };
    await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
    await sh("git", ["-C", dir, "config", "user.name", "JARVIS"], env);

    const mem: any[] = (await q("memory:recent", { limit: 60 })) ?? [];
    const ins: any[] = (await q("business:recentInsights", { limit: 10 })) ?? [];
    const biz: any[] = (await q("business:list", {})) ?? [];
    const stack: any[] = (await q("projectState:list", {})) ?? [];
    const date = new Date().toISOString().slice(0, 10);
    for (const f of ["60-logs", "70-metrics", "20-projects", "30-decisions", "80-facts", "00-MOCs"])
      mkdirSync(join(dir, f), { recursive: true });

    // dated log (idempotent per day — rewrite with the current snapshot)
    const log = [
      `---\ntype: log\ndate: ${date}\n---`,
      `# Log ${date}`,
      "",
      "## Insights noticed",
      ...(ins.length ? ins.map((i: any) => `- ${clean(i.text)}`) : ["- (none)"]),
      "",
      "## Remembered",
      ...mem.slice(0, 15).map((m: any) => `- **${clean(m.title)}** — ${clean(m.body)}`),
      "",
      "Links: [[index]]",
    ];
    writeFileSync(join(dir, "60-logs", `${date}.md`), log.join("\n"));

    // rental metric snapshot, wikilinked to its project node
    const rental = biz.find((b: any) => b.domain === "rental");
    if (rental) {
      writeFileSync(
        join(dir, "70-metrics", `rental-${date}.md`),
        [
          `---\ntype: metric\ndomain: rental\ndate: ${date}\n---`,
          `# Rental snapshot ${date}`,
          "",
          clean(rental.headline),
          clean(rental.detail || ""),
          "",
          "Project: [[rental-manager]] · [[index]]",
        ].join("\n"),
      );
    }

    // living project-state notes: JARVIS keeps himself current on every app
    // (status + what changed lately) — refreshed on every consolidation run.
    for (const s of stack) {
      const sl = slug(s.slug);
      if (!sl) continue;
      writeFileSync(
        join(dir, "20-projects", `${sl}-state.md`),
        [
          `---\ntype: project-state\nproject: ${sl}\nstatus: ${clean(s.status)}\nupdated: ${date}\n---`,
          `# ${clean(s.slug)} — current state`,
          "",
          `Status: **${clean(s.status)}**`,
          clean(s.summary || ""),
          s.data?.recent ? `\nRecently changed: ${clean(String(s.data.recent)).slice(0, 600)}` : "",
          "",
          `Links: [[index]] · [[${sl}]]`,
        ].join("\n"),
      );
    }

    // atomic categorised notes (one concept per file) with frontmatter + links
    let notes = 0;
    for (const m of mem) {
      const kind = String(m.kind || "fact");
      if (!["fact", "preference", "decision", "project", "knowledge"].includes(kind)) continue;
      const folder = kind === "decision" ? "30-decisions" : kind === "project" ? "20-projects" : "80-facts";
      const s = slug(m.title);
      if (!s) continue;
      writeFileSync(
        join(dir, folder, `${s}.md`),
        [
          `---\ntype: ${kind}\ntitle: ${JSON.stringify(String(m.title))}\ntags: [${(m.tags || []).join(", ")}]\nupdated: ${date}\n---`,
          `# ${clean(m.title)}`,
          "",
          clean(m.body),
          "",
          "Links: [[index]]",
        ].join("\n"),
      );
      notes++;
    }

    await sh("git", ["-C", dir, "add", "-A"], env);
    const commit = await sh("git", ["-C", dir, "commit", "-m", `memory: consolidate ${date}`], env);
    let pushed = false;
    if (!/nothing to commit/i.test(commit.out)) {
      const push = await sh("git", ["-C", dir, "push", url, "HEAD"], gitEnv);
      pushed = push.code === 0;
    }
    return { date, notes, insights: ins.length, pushed };
  },
});
