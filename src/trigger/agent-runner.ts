import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

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
function runClaude(bin: string, cwd: string, env: NodeJS.ProcessEnv, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(
      bin,
      ["-p", prompt, "--model", "opus", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let buf = "";
    let finalText = "";
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
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });
    p.on("close", () => {
      clearTimeout(to);
      resolve(finalText || "(no output)");
    });
    p.on("error", (e) => {
      clearTimeout(to);
      resolve("error: " + e.message);
    });
  });
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
        if (job.repo && token) {
          const dir = `/tmp/work/${String(job.repo).replace(/[^a-zA-Z0-9]/g, "_")}`;
          const url = `https://x-access-token:${token}@github.com/${job.repo}.git`;
          await sh("git", ["clone", "--depth", "1", url, dir], env);
          if (existsSync(join(dir, ".git"))) {
            cwd = dir;
            repoDir = dir;
            await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
            await sh("git", ["-C", dir, "config", "user.name", "JARVIS"], env);
            context =
              `Your working directory IS the git repo ${job.repo} (cloned). Make the changes and commit ` +
              "them (git -C . commit -am '...') but do NOT push — the runner pushes for you.";
          } else {
            context = `Repo ${job.repo} could not be cloned; work from knowledge, no file edits.`;
          }
        }
        const result = await runClaude(bin, cwd, env, `${context}\n\nTask: ${job.task}`);

        let pushNote = "";
        if (repoDir && token && !job.readonly) {
          const pushUrl = `https://x-access-token:${token}@github.com/${job.repo}.git`;
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

        await convexMutation("jobs:finalize", { jobId: job.jobId, status: "done", result: result.slice(0, 4000) });
        await convexMutation("chatQueue:postAssistant", {
          threadId: "main",
          text: `✅ Agent finished${job.repo ? ` on ${job.repo}` : ""}${pushNote}:\n${result.slice(0, 700)}`,
        });
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
