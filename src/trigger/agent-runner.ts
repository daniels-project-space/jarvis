import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { sendPush } from "./push-send";

// Slice D — dispatch. Claims background jobs (enqueued by the brain), runs a
// Claude Code / Opus agent on them (optionally cloning a repo, committing +
// pushing changes), and reports the result back into the chat. Subscription auth.

const nodeRequire = createRequire(import.meta.url);
const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

function resolveClaudeBin(): string | null {
  try {
    const pkgJson = nodeRequire.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", "claude")];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
      /* ignore */
    }
    return candidates.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}
async function convexMutation(path: string, args: unknown) {
  return (
    await (
      await fetch(`${CONVEX_URL}/api/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args, format: "json" }),
      })
    ).json()
  ).value;
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
// Sub-agent model routing: match the brain's economy — Opus only for real
// engineering, Sonnet for the middle, Haiku for trivial lookups/one-liners.
function pickAgentModel(task: string): string {
  const t = task.toLowerCase();
  if (/\b(architect|design|refactor|migrate|debug|root cause|complex|multi-file|rewrite|optimi[sz]e)\b/.test(t))
    return "opus";
  if (t.length < 80 && /\b(check|list|read|look up|status|find|grep|what is|summari[sz]e)\b/.test(t))
    return "haiku";
  return "sonnet";
}

function runClaude(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  model: string,
  onProgress?: (s: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(
      bin,
      ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buf = "";
    let finalText = "";
    let latest = "starting up…";
    let dirty = false;
    const timer = onProgress
      ? setInterval(() => {
          if (dirty) {
            dirty = false;
            onProgress(latest);
          }
        }, 1500)
      : null;
    const to = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(finalText || "(agent timed out)");
    }, 420_000);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "assistant" && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === "tool_use") {
              latest = `Using ${b.name}${b.input?.command ? ": " + String(b.input.command).slice(0, 80) : b.input?.file_path ? ": " + b.input.file_path : ""}`;
              dirty = true;
            } else if (b.type === "text" && b.text?.trim()) {
              latest = b.text.trim().replace(/\s+/g, " ").slice(-160);
              dirty = true;
            }
          }
        } else if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });
    p.on("close", () => {
      clearTimeout(to);
      if (timer) clearInterval(timer);
      resolve(finalText || "(no output)");
    });
    p.on("error", (e) => {
      clearTimeout(to);
      if (timer) clearInterval(timer);
      resolve("error: " + e.message);
    });
  });
}

// Bare project names silently fail to clone — resolve them to full owner/repo.
const REPO_ALIASES: Record<string, string> = {
  "project-hub": "daniels-project-space/project-hub-app",
  "project-hub-app": "daniels-project-space/project-hub-app",
  "rental-manager-v2": "daniels-project-space/rental-manager-v2",
  rmv2: "daniels-project-space/rental-manager-v2",
  "music-house": "daniels-project-space/music-house",
  "youtube-studio-ai": "daniels-project-space/youtube-studio-ai",
  "finance-engine-v2": "daniels-project-space/finance-engine-v2",
  "dropship-ai": "daniels-project-space/dropship-ai",
  jarvis: "daniels-project-space/jarvis",
  "jarvis-memory": "daniels-project-space/jarvis-memory",
};
function resolveRepo(name: string): string {
  const n = String(name || "")
    .trim()
    .replace(/\.git$/, "");
  if (!n) return "";
  const alias = REPO_ALIASES[n.toLowerCase()];
  if (alias) return alias;
  if (n.includes("/")) return n;
  return `daniels-project-space/${n}`; // default org
}

export const agentRunner = schedules.task({
  id: "jarvis-agent-runner",
  cron: "*/2 * * * *",
  maxDuration: 900,
  run: async () => {
    const bin = resolveClaudeBin();
    if (!bin) return { processed: 0, error: "no claude binary" };
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: "/tmp/claude-home", ANTHROPIC_API_KEY: "" };
    mkdirSync("/tmp/claude-home", { recursive: true });
    const token = process.env.GITHUB_TOKEN ?? "";

    let processed = 0;
    const started = Date.now();
    while (Date.now() - started < 220_000) {
      const job: any = await convexMutation("jobs:claimNext", {});
      if (!job) break;
      try {
        let cwd = "/tmp/work/scratch";
        mkdirSync(cwd, { recursive: true });
        let context = "You cannot edit files this run — answer/act from knowledge.";
        let repoDir: string | null = null;
        const repo = resolveRepo(job.repo);
        let cloneFailed = false;
        if (repo && token) {
          const dir = `/tmp/work/${repo.replace(/[^a-zA-Z0-9]/g, "_")}`;
          rmSync(dir, { recursive: true, force: true });
          const url = `https://x-access-token:${token}@github.com/${repo}.git`;
          await sh("git", ["clone", "--depth", "1", url, dir], env);
          if (existsSync(join(dir, ".git"))) {
            cwd = dir;
            repoDir = dir;
            await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
            await sh("git", ["-C", dir, "config", "user.name", "JARVIS"], env);
            context =
              `Your working directory IS the git repo ${repo} (freshly cloned). Actually DO the task by editing files, ` +
              "then commit (git -C . commit -am '...'); do NOT push — the runner pushes. Skip npm install / builds unless truly essential to the task.";
          } else {
            cloneFailed = true;
            context = `The repo ${repo} could NOT be cloned (wrong name or no access). Do NOT pretend you edited anything — state plainly that you couldn't access it, and give the best guidance you can from knowledge.`;
          }
        }
        const model = typeof job.model === "string" && job.model ? job.model : pickAgentModel(job.task);
        const result = await runClaude(bin, cwd, env, `${context}\n\nTask: ${job.task}`, model, (line) => {
          void convexMutation("jobs:updateProgress", { jobId: job.jobId, progress: line });
        });

        let pushNote = "";
        if (repoDir && token && !job.readonly) {
          const pushUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
          await sh("git", ["-C", repoDir, "add", "-A"], env);
          const commit = await sh("git", ["-C", repoDir, "commit", "-m", "fix: jarvis agent"], env);
          if (/nothing to commit/i.test(commit.out)) {
            pushNote = " · no changes made";
          } else {
            let push = await sh("git", ["-C", repoDir, "push", pushUrl, "HEAD"], env);
            if (/shallow update not allowed/i.test(push.out)) {
              await sh("git", ["-C", repoDir, "fetch", "--unshallow"], env);
              push = await sh("git", ["-C", repoDir, "push", pushUrl, "HEAD"], env);
            }
            pushNote =
              push.code === 0 ? " · pushed ✅" : ` · push FAILED: ${push.out.slice(-140).replace(/\s+/g, " ")}`;
          }
        }

        const status = cloneFailed ? "error" : "done";
        await convexMutation("jobs:finalize", { jobId: job.jobId, status, result: result.slice(0, 4000) });
        const head = cloneFailed
          ? `⚠️ Couldn't reach ${repo} — check the repo name or my access. Best I can tell you:`
          : `✅ Agent finished${repo ? ` on ${repo}` : ""}${pushNote}:`;
        await convexMutation("chatQueue:postAssistant", {
          threadId: "main",
          text: `${head}\n${result.slice(0, 700)}`,
        });
        await sendPush(
          cloneFailed ? `⚠️ Couldn't reach ${repo}` : `✅ Agent finished${repo ? ` on ${repo}` : ""}`,
          result.slice(0, 140),
          "/",
        );
        processed += 1;
      } catch (e: any) {
        await convexMutation("jobs:finalize", { jobId: job.jobId, status: "error", result: String(e?.message ?? e) });
        await convexMutation("chatQueue:postAssistant", {
          threadId: "main",
          text: `⚠️ Agent failed: ${String(e?.message ?? e).slice(0, 300)}`,
        }).catch(() => {});
      }
    }
    return { processed };
  },
});
