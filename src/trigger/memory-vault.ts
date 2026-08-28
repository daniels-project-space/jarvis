import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { githubGitEnv, githubRepoUrl } from "./git-transport";
import { redactSecrets, safeMemoryNote } from "../lib/memory-safety";
import { environmentWithoutSubscriptionController } from "./subscription-source";

// Obsidian memory vault: consolidates JARVIS's memory into a git-backed,
// categorised, wikilinked Obsidian vault (daniels-project-space/jarvis-memory) —
// the durable, browsable source-of-truth. Convex stays the fast recall index.
// This is the "not-cheap" memory: folders + frontmatter + [[links]], not flat KV.

const CONVEX =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const REPO = "daniels-project-space/jarvis-memory";

type MemoryRow = { kind?: unknown; title?: unknown; body?: unknown; tags?: unknown[] };
type MemoryReconciliation = { cycle?: unknown; cutoffAt?: unknown; cursor?: unknown };
type MemoryReconciliationPage = { items?: unknown; isDone?: unknown; continueCursor?: unknown };
type AttentionRow = { title?: unknown; detail?: unknown; status?: unknown };
type BusinessRow = { domain?: unknown; headline?: unknown; detail?: unknown };
type ProjectRow = { slug?: unknown; status?: unknown; summary?: unknown; data?: { recent?: unknown } };

// Keep the scheduled durable mirror aligned with the real-time `remember`
// tool. In particular, Stage 0 extracts actionable tasks into Convex; omitting
// them here made those automatically remembered tasks invisible in Obsidian.
const OBSIDIAN_MEMORY_FOLDERS: Readonly<Record<string, string>> = {
  decision: "30-decisions",
  project: "20-projects",
  task: "80-facts",
  preference: "80-facts",
  fact: "80-facts",
  knowledge: "80-facts",
};

export function obsidianMemoryFolderForKind(kind: unknown): string | null {
  return OBSIDIAN_MEMORY_FOLDERS[String(kind || "fact")] ?? null;
}

async function convexCall(kind: "query" | "mutation", path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  try {
    const response = await fetch(`${CONVEX}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: { ...((args ?? {}) as Record<string, unknown>), workerToken }, format: "json" }),
    });
    const payload = await response.json().catch(() => null) as { value?: unknown; status?: string } | null;
    return response.ok && payload?.status !== "error" ? payload?.value ?? null : null;
  } catch {
    return null;
  }
}

async function q(path: string, args: unknown) {
  return await convexCall("query", path, args);
}

async function m(path: string, args: unknown) {
  return await convexCall("mutation", path, args);
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
const slug = (s: unknown) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
const clean = (s: unknown) => redactSecrets(s).replace(/[*#`_>]/g, "").trim();

// The fast Convex recall index is consolidated into the durable Obsidian
// mirror on the documented six-hour cadence. Keep this exported so the
// schedule contract is covered without ever running a vault write in tests.
export const MEMORY_VAULT_CRON = "17 */6 * * *";

export const memoryVault = schedules.task({
  id: "jarvis-memory-vault",
  cron: MEMORY_VAULT_CRON,
  maxDuration: 180,
  run: async () => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return { error: "no GITHUB_TOKEN" };
    const dir = "/tmp/vault";
    rmSync(dir, { recursive: true, force: true });
    const url = githubRepoUrl(REPO);
    // Git is unrelated to the trusted Codex parent. Copy host variables only
    // after rejecting every subscription-controller name, including retired
    // inputs that may linger while an old Trigger revision drains.
    const env = environmentWithoutSubscriptionController(process.env);
    env.HOME = "/tmp/jarvis-memory-controller-home";
    env.GIT_CONFIG_NOSYSTEM = "1";
    mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
    const gitEnv = githubGitEnv(env, token);
    await sh("git", ["clone", "--depth", "1", url, dir], gitEnv);
    if (!existsSync(join(dir, ".git"))) return { error: "clone failed" };
    await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
    await sh("git", ["-C", dir, "config", "user.name", "JARVIS"], env);

    const reconciliation = await m("memory:beginObsidianReconciliation", {}) as MemoryReconciliation | null;
    const cycle = Number(reconciliation?.cycle);
    const cutoffAt = Number(reconciliation?.cutoffAt);
    const cursor = typeof reconciliation?.cursor === "string" ? reconciliation.cursor : undefined;
    if (!Number.isSafeInteger(cycle) || cycle < 1 || !Number.isFinite(cutoffAt)) {
      return { error: "memory reconciliation unavailable" };
    }
    const reconciliationPage = await q("memory:obsidianReconciliationPage", {
      cycle,
      cutoffAt,
      ...(cursor ? { cursor } : {}),
    }) as MemoryReconciliationPage | null;
    const isDone = reconciliationPage?.isDone === true;
    const continueCursor = typeof reconciliationPage?.continueCursor === "string"
      ? reconciliationPage.continueCursor
      : undefined;
    if (!reconciliationPage || !Array.isArray(reconciliationPage.items) || (!isDone && !continueCursor)) {
      return { error: "memory reconciliation page unavailable" };
    }
    const mem = reconciliationPage.items as MemoryRow[];
    // The daily log stays a compact current summary. The resumable page above
    // is deliberately oldest-first, so it must not drive this owner-facing
    // recency view.
    const recentMem = ((await q("memory:recent", { limit: 15 })) as MemoryRow[] | null) ?? [];
    const attention = ((await q("attention:list", { status: "open", limit: 10 })) as AttentionRow[] | null) ?? [];
    const biz = ((await q("business:list", {})) as BusinessRow[] | null) ?? [];
    const stack = ((await q("projectState:list", {})) as ProjectRow[] | null) ?? [];
    const date = new Date().toISOString().slice(0, 10);
    for (const f of ["60-logs", "70-metrics", "20-projects", "30-decisions", "80-facts", "00-MOCs"])
      mkdirSync(join(dir, f), { recursive: true });

    // dated log (idempotent per day — rewrite with the current snapshot)
    const log = [
      `---\ntype: log\ndate: ${date}\n---`,
      `# Log ${date}`,
      "",
      "## Attention noticed",
      ...(attention.length ? attention.map((item) => `- **${clean(item.title)}** — ${clean(item.detail)}`) : ["- (none)"]),
      "",
      "## Remembered",
      ...recentMem
        .slice(0, 15)
        .map((m) => safeMemoryNote(m.title, m.body))
        .filter((note): note is { title: string; body: string } => Boolean(note))
        .map((note) => `- **${clean(note.title)}** — ${clean(note.body)}`),
      "",
      "Links: [[index]]",
    ];
    writeFileSync(join(dir, "60-logs", `${date}.md`), log.join("\n"));

    // rental metric snapshot, wikilinked to its project node
    const rental = biz.find((b) => b.domain === "rental");
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
      const folder = obsidianMemoryFolderForKind(kind);
      if (!folder) continue;
      const note = safeMemoryNote(m.title, m.body);
      if (!note) continue;
      const s = slug(note.title);
      if (!s) continue;
      writeFileSync(
        join(dir, folder, `${s}.md`),
        [
          `---\ntype: ${kind}\ntitle: ${JSON.stringify(note.title)}\ntags: [${(m.tags || []).map(clean).join(", ")}]\nupdated: ${date}\n---`,
          `# ${clean(note.title)}`,
          "",
          clean(note.body),
          "",
          "Links: [[index]]",
        ].join("\n"),
      );
      notes++;
    }

    const add = await sh("git", ["-C", dir, "add", "-A"], env);
    if (add.code !== 0) {
      return { date, notes, attention: attention.length, pushed: false, error: "Obsidian mirror staging did not complete" };
    }
    // `git diff --cached --quiet` exits 0 only when staging is verified clean,
    // 1 when there is a commit-worthy page, and >1 on a Git failure. This is
    // stronger than parsing `git commit` text after a failed `git add`.
    const staged = await sh("git", ["-C", dir, "diff", "--cached", "--quiet"], env);
    if (staged.code !== 0 && staged.code !== 1) {
      return { date, notes, attention: attention.length, pushed: false, error: "Obsidian mirror staging could not be verified" };
    }
    let pushed = false;
    if (staged.code === 1) {
      const commit = await sh("git", ["-C", dir, "commit", "-m", `memory: consolidate ${date}`], env);
      if (commit.code !== 0) {
        return { date, notes, attention: attention.length, pushed, error: "Obsidian mirror commit did not complete" };
      }
      const push = await sh("git", ["-C", dir, "push", url, "HEAD"], gitEnv);
      pushed = push.code === 0;
    }
    if (staged.code === 1 && !pushed) {
      // Do not advance: a retry may rewrite this page, but cannot leave a
      // canonical memory absent from the durable mirror.
      return { date, notes, attention: attention.length, pushed, error: "Obsidian mirror push did not complete" };
    }
    const checkpoint = await m("memory:advanceObsidianReconciliation", {
      cycle,
      cutoffAt,
      ...(cursor ? { fromCursor: cursor } : {}),
      complete: isDone,
      ...(!isDone && continueCursor ? { continueCursor } : {}),
    }) as { ok?: unknown } | null;
    if (checkpoint?.ok !== true) {
      // The mirror is safe; retain the page cursor so a later run can replay
      // it rather than risking a skipped write after a transient API failure.
      return { date, notes, attention: attention.length, pushed, error: "Obsidian mirror checkpoint did not complete" };
    }
    return { date, notes, attention: attention.length, pushed, reconciliationComplete: isDone };
  },
});
