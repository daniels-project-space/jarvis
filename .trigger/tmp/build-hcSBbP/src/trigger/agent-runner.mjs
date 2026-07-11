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

// src/trigger/agent-runner.ts
init_esm();
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
var nodeRequire = createRequire(import.meta.url);
var CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
function resolveClaudeBin() {
  try {
    const pkgJson = nodeRequire.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", "claude")];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.claude;
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
    }
    return candidates.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}
__name(resolveClaudeBin, "resolveClaudeBin");
async function convexMutation(path, args) {
  return (await (await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" })
  })).json()).value;
}
__name(convexMutation, "convexMutation");
function sh(cmd, args, env) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    p.stdout.on("data", (d) => o += d.toString());
    p.stderr.on("data", (d) => o += d.toString());
    p.on("close", (code) => res({ code, out: o }));
    p.on("error", () => res({ code: -1, out: o }));
  });
}
__name(sh, "sh");
function pickAgentModel(task) {
  const t = task.toLowerCase();
  if (/\b(architect|design|refactor|migrate|debug|root cause|complex|multi-file|rewrite|optimi[sz]e)\b/.test(t))
    return "opus";
  if (t.length < 80 && /\b(check|list|read|look up|status|find|grep|what is|summari[sz]e)\b/.test(t))
    return "haiku";
  return "sonnet";
}
__name(pickAgentModel, "pickAgentModel");
function runClaude(bin, cwd, env, prompt, model) {
  return new Promise((resolve) => {
    const p = spawn(
      bin,
      ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let buf = "";
    let finalText = "";
    const to = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
      }
      resolve(finalText || "(agent timed out)");
    }, 42e4);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
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
__name(runClaude, "runClaude");
var agentRunner = schedules_exports.task({
  id: "jarvis-agent-runner",
  cron: "*/2 * * * *",
  maxDuration: 900,
  run: /* @__PURE__ */ __name(async () => {
    const bin = resolveClaudeBin();
    if (!bin) return { processed: 0, error: "no claude binary" };
    const env = { ...process.env, HOME: "/tmp/claude-home", ANTHROPIC_API_KEY: "" };
    mkdirSync("/tmp/claude-home", { recursive: true });
    const token = process.env.GITHUB_TOKEN ?? "";
    let processed = 0;
    const started = Date.now();
    while (Date.now() - started < 22e4) {
      const job = await convexMutation("jobs:claimNext", {});
      if (!job) break;
      try {
        let cwd = "/tmp/work/scratch";
        mkdirSync(cwd, { recursive: true });
        let context = "You cannot edit files this run — answer/act from knowledge.";
        let repoDir = null;
        if (job.repo && token) {
          const dir = `/tmp/work/${String(job.repo).replace(/[^a-zA-Z0-9]/g, "_")}`;
          const url = `https://x-access-token:${token}@github.com/${job.repo}.git`;
          await sh("git", ["clone", "--depth", "1", url, dir], env);
          if (existsSync(join(dir, ".git"))) {
            cwd = dir;
            repoDir = dir;
            await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
            await sh("git", ["-C", dir, "config", "user.name", "JARVIS"], env);
            context = `Your working directory IS the git repo ${job.repo} (cloned). Make the changes and commit them (git -C . commit -am '...') but do NOT push — the runner pushes for you.`;
          } else {
            context = `Repo ${job.repo} could not be cloned; work from knowledge, no file edits.`;
          }
        }
        const model = typeof job.model === "string" && job.model ? job.model : pickAgentModel(job.task);
        const result = await runClaude(bin, cwd, env, `${context}

Task: ${job.task}`, model);
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
            pushNote = push.code === 0 ? " · pushed ✅" : ` · push FAILED: ${push.out.slice(-140).replace(/\s+/g, " ")}`;
          }
        }
        await convexMutation("jobs:finalize", { jobId: job.jobId, status: "done", result: result.slice(0, 4e3) });
        await convexMutation("chatQueue:postAssistant", {
          threadId: "main",
          text: `✅ Agent finished${job.repo ? ` on ${job.repo}` : ""}${pushNote}:
${result.slice(0, 700)}`
        });
        await sendPush(`✅ Agent finished${job.repo ? ` on ${job.repo}` : ""}`, result.slice(0, 140), "/");
        processed += 1;
      } catch (e) {
        await convexMutation("jobs:finalize", { jobId: job.jobId, status: "error", result: String(e?.message ?? e) });
        await convexMutation("chatQueue:postAssistant", {
          threadId: "main",
          text: `⚠️ Agent failed: ${String(e?.message ?? e).slice(0, 300)}`
        }).catch(() => {
        });
      }
    }
    return { processed };
  }, "run")
});
export {
  agentRunner
};
//# sourceMappingURL=agent-runner.mjs.map
