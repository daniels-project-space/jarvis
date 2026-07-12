import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { sendPush } from "./push-send";
import { INFRA_MAP } from "../lib/persona";

// Slice D — dispatch. Claims background jobs (enqueued by the brain), runs a
// Claude Code / Opus agent on them (optionally cloning a repo, committing +
// pushing changes, optionally with MCP servers attached), then WEAVES the result
// into conversation as one natural spoken line + a findings row (never a dump).

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
// Weaves land wherever Daniel is actually chatting.
async function chatThread(): Promise<string> {
  const t = await convexQuery("ui:getActiveThread", {});
  return typeof t === "string" && t ? t : "main";
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

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
async function vaultService(service: string): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${VAULT_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
    });
    const rows = ((await r.json()).value ?? []) as { keyName: string; value: string }[];
    return Object.fromEntries(rows.map((s) => [s.keyName, s.value]));
  } catch {
    return {};
  }
}

// MCP servers the brain can attach on demand. Browserbase = hosted browsers
// (no local Chromium in the Trigger image); context7 = live library docs.
async function buildMcpConfig(names: string[]): Promise<string | null> {
  const servers: Record<string, unknown> = {};
  for (const n of names) {
    if (["playwright", "browser", "browserbase"].includes(n)) {
      const bb = await vaultService("browserbase");
      if (bb.BROWSERBASE_API_KEY)
        servers["browserbase"] = {
          command: "npx",
          args: ["-y", "@browserbasehq/mcp-server-browserbase"],
          env: { BROWSERBASE_API_KEY: bb.BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID: bb.BROWSERBASE_PROJECT_ID ?? "" },
        };
    }
    if (n === "context7") servers["context7"] = { command: "npx", args: ["-y", "@upstash/context7-mcp"] };
  }
  if (!Object.keys(servers).length) return null;
  const path = "/tmp/mcp.json";
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  return path;
}

// The weave: a short spoken report that CONTAINS the answer — Daniel complained
// that "it's done, sir" told him nothing after he sent an agent off to research.
async function weaveLine(bin: string, env: NodeJS.ProcessEnv, task: string, result: string): Promise<string> {
  const prompt =
    "You are JARVIS, Daniel's British AI companion. A background agent you dispatched just finished. " +
    "Report back like a colleague leaning over: 1-3 short spoken sentences (max 60 words) that DELIVER THE ACTUAL " +
    "ANSWER — the concrete findings, numbers, names or recommendation — not just that the work happened. " +
    "End by mentioning the full detail is on his screen. No markdown, no emoji, no preamble. " +
    "If it failed, say what failed honestly in one sentence.\n\n" +
    `The task was: ${task.slice(0, 300)}\nThe result:\n${result.slice(0, 3500)}`;
  const out = await new Promise<string>((resolve) => {
    const p = spawn(bin, ["-p", prompt, "--model", "haiku", "--dangerously-skip-permissions"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    const to = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve(o);
    }, 60_000);
    p.stdout.on("data", (d) => (o += d.toString()));
    p.on("close", () => {
      clearTimeout(to);
      resolve(o);
    });
    p.on("error", () => {
      clearTimeout(to);
      resolve("");
    });
  });
  const line = out.trim().replace(/\s+/g, " ").replace(/[*#`_]/g, "");
  return line.length > 4 && line.length < 400 ? line : "";
}

function runClaude(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  model: string,
  onProgress?: (s: string) => void,
  mcpConfig?: string | null,
): Promise<string> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (mcpConfig) args.push("--mcp-config", mcpConfig);
    const p = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    }, 900_000); // self-repair/improve jobs may run npm install + tsc + build inside the turn
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
  "project-hub": "daniels-project-space/project-hub",
  "project-hub-app": "daniels-project-space/project-hub",
  hub: "daniels-project-space/project-hub",
  "remote-work-hub": "daniels-project-space/remote-work-hub",
  "media-engine": "daniels-project-space/media-engine",
  "app-factory-v2": "daniels-project-space/app-factory-v2",
  "db-cinema-v2": "daniels-project-space/db-cinema-v2",
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

// Root-cause repair briefing for self-healing jobs.
export function repairPrompt(inc: { source: string; message: string; signature: string; count: number; attempts: number }, repo: string): string {
  return (
    `SELF-REPAIR (attempt ${inc.attempts}): something in Daniel's system is broken — trace the ROOT CAUSE and fix it. ` +
    `Never paper over symptoms.\n\n` +
    `Incident (source: ${inc.source}, seen ${inc.count}x): ${inc.message}\n\n` +
    `Method, in order: 1) REPRODUCE — hit the live endpoints (e.g. curl https://jarvis-orcin-six.vercel.app/api/...) ` +
    `or read the failing path until you can explain the error. 2) Trace to the underlying cause in the code of ${repo}. ` +
    `3) Apply the MINIMAL correct fix. 4) VALIDATE proportionally: for a small single-file change, re-read your full diff line by line instead of building (the clone has no node_modules; Vercel's build is the gate and a failed deploy auto-files an incident straight back to you). For multi-file or risky changes, run "npm install" then "npx tsc --noEmit" and "npm run build" — they must pass. ` +
    `5) Commit ONLY working code with a message starting "self-repair:". ` +
    `If the true fix needs convex/ or src/trigger/ redeploy (you cannot deploy those), still commit and SAY SO plainly. ` +
    `If you cannot find the root cause, do NOT guess-edit — say exactly what you ruled out and what you suspect.`
  );
}

export const agentRunner = schedules.task({
  id: "jarvis-agent-runner",
  cron: "*/2 * * * *",
  maxDuration: 1800,
  run: async () => {
    const bin = resolveClaudeBin();
    if (!bin) return { processed: 0, error: "no claude binary" };

    // Self-healing sweep: open incidents become root-cause repair jobs (attempt-
    // capped); exhausted ones escalate to Daniel instead of looping forever.
    try {
      await convexMutation("chatQueue:reapStuck", {}).catch(() => {}); // unstick frozen typing bubbles
      const reaped: any = await convexMutation("jobs:reapStale", {});
      for (const t of reaped?.abandoned ?? [])
        await convexMutation("chatQueue:postAssistant", {
          threadId: await chatThread(),
          text: `I have to be honest, sir — the background job "${t}" kept dying on me and I've stopped retrying it.`,
        }).catch(() => {});
      const healer: any = await convexMutation("incidents:claimForRepair", { limit: 2, maxAttempts: 2 });
      for (const inc of healer?.claims ?? []) {
        const repo = inc.app && inc.app !== "jarvis" ? inc.app : "jarvis";
        await convexMutation("jobs:enqueue", {
          task: repairPrompt(inc, repo),
          repo,
          model: "opus",
          incidentId: String(inc.id),
        });
      }
      for (const esc of healer?.escalations ?? []) {
        await convexMutation("chatQueue:postAssistant", {
          threadId: await chatThread(),
          text: `Sir, I've had two goes at fixing "${String(esc.message).slice(0, 120)}" and it's still misbehaving — this one needs your eyes.`,
        });
        await sendPush("JARVIS needs you", String(esc.message).slice(0, 120), "/");
      }
    } catch {
      /* healer must never block normal jobs */
    }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: "/tmp/claude-home", ANTHROPIC_API_KEY: "" };
    mkdirSync("/tmp/claude-home/.claude", { recursive: true });
    mkdirSync("/tmp/work", { recursive: true });
    const token = process.env.GITHUB_TOKEN ?? "";

    // Standing briefing every agent reads (global CLAUDE.md in the runner HOME):
    // Daniel's infra map + vault access + repo/deploy conventions = real project access.
    writeFileSync(
      "/tmp/claude-home/.claude/CLAUDE.md",
      `# You are a JARVIS background agent working for Daniel.\n\n${INFRA_MAP}\n\n` +
        `## Secrets vault (use freely when a task needs API keys)\n` +
        `curl -s -X POST '${VAULT_URL}/api/query' -H 'content-type: application/json' -d '{"path":"secrets:listByService","args":{"service":"<service>"},"format":"json"}'\n` +
        `List all services: same call with path "secrets:summary" and args {}.\n\n` +
        `## Conventions\n- Cloning any Daniel repo: use env GITHUB_TOKEN as x-access-token basic auth.\n` +
        `- Web research: use your WebSearch/WebFetch tools directly.\n` +
        `- Never invent results. If something is inaccessible, say so plainly in your final answer.\n` +
        `- Final answer style: plain text, the key outcome first, under 300 words.\n`,
    );

    let processed = 0;
    const started = Date.now();

    // One agent's full lifecycle: clone, run, push, finalize, report. Mission
    // jobs stay quiet individually — the fleet reports ONCE when the last
    // agent lands (synthesis below).
    const processJob = async (job: any): Promise<void> => {
      try {
        let cwd = `/tmp/work/scratch-${String(job.jobId).slice(-6)}`;
        mkdirSync(cwd, { recursive: true });
        let context = "You cannot edit files this run — answer/act from knowledge.";
        let repoDir: string | null = null;
        const repo = resolveRepo(job.repo);
        let cloneFailed = false;
        if (repo && token) {
          // per-job clone dir — concurrent fleet agents must not share checkouts
          const dir = `/tmp/work/${repo.replace(/[^a-zA-Z0-9]/g, "_")}_${String(job.jobId).slice(-6)}`;
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
        const mcpConfig = Array.isArray(job.mcp) && job.mcp.length ? await buildMcpConfig(job.mcp) : null;
        const result = await runClaude(
          bin,
          cwd,
          env,
          `${context}\n\nTask: ${job.task}`,
          model,
          (line) => {
            void convexMutation("jobs:updateProgress", { jobId: job.jobId, progress: line });
          },
          mcpConfig,
        );

        let pushNote = "";
        if (repoDir && token && !job.readonly) {
          const pushUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
          // Sweep up any uncommitted leftovers (agents usually commit themselves).
          await sh("git", ["-C", repoDir, "add", "-A"], env);
          await sh(
            "git",
            ["-C", repoDir, "commit", "-m", `chore: jarvis agent — ${job.task.slice(0, 60).replace(/"/g, "'")}`],
            env,
          );
          // ALWAYS push when HEAD moved — the agent may have committed on its
          // own; only pushing after a runner-side commit stranded agent commits.
          const local = (await sh("git", ["-C", repoDir, "rev-parse", "HEAD"], env)).out.trim();
          const remote = (await sh("git", ["-C", repoDir, "ls-remote", pushUrl, "HEAD"], env)).out.split(/\s/)[0]?.trim();
          if (local && remote && local === remote) {
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
        // Self-repair bookkeeping: success resolves the incident; failure reopens
        // it so the healer retries (attempt cap prevents loops).
        if (job.incidentId) {
          const fixed = !cloneFailed && !/push FAILED/.test(pushNote);
          await convexMutation("incidents:setStatus", {
            id: job.incidentId,
            status: fixed ? "resolved" : "open",
          }).catch(() => {});
        }

        // Failed or timed-out work retries ONCE with explicit instructions to
        // try differently — then reports honestly instead of going quiet.
        const failedRun = cloneFailed || result === "(agent timed out)" || /^error:/.test(result);
        if (failedRun && !job.retried && !cloneFailed) {
          await convexMutation("jobs:enqueue", {
            task:
              `PREVIOUS ATTEMPT FAILED (${result.slice(0, 200)}). Try a DIFFERENT approach this time — different tools, ` +
              `smaller steps, or state plainly what's impossible and why.\n\nOriginal task: ${job.task}`,
            repo: job.repo ?? undefined,
            model: job.model ?? undefined,
            incidentId: job.incidentId ?? undefined,
            missionId: job.missionId ?? undefined,
            label: job.label ?? undefined,
            retried: true,
          });
          if (!job.missionId)
            await convexMutation("chatQueue:postAssistant", {
              threadId: await chatThread(),
              text: "That one hit a snag, sir — retrying it a different way now.",
            });
          return;
        }

        if (job.missionId) {
          // Fleet agents stay quiet individually — findings recorded, and the
          // LAST agent to land triggers ONE synthesized mission report.
          await convexMutation("findings:add", {
            source: job.task,
            spoken: `Fleet update: "${job.label ?? job.task.slice(0, 40)}" is done.`,
            detail: result.slice(0, 8000),
          }).catch(() => {});
          await maybeSynthesizeMission(job.missionId);
          return;
        }

        // Weave, don't dump: one natural spoken line into chat + the full detail
        // as a finding the brain can pull up ("show me what it found").
        const spoken =
          (await weaveLine(bin, env, job.task, `${result}${pushNote}`)) ||
          (cloneFailed
            ? `Couldn't get into ${repo}, sir — the repo name or access looks wrong.`
            : `That background job's done${pushNote.includes("pushed") ? " and the change is live" : ""}.`);
        const findingId = await convexMutation("findings:add", {
          source: job.task,
          spoken,
          detail: result.slice(0, 8000) + (pushNote ? `\n\n(${pushNote.trim()})` : ""),
        });
        // The runner is about to DELIVER this itself (spoken line + card) — mark
        // it woven now, or the brain re-announces the same finding on Daniel's
        // next message ("telling me its findings twice").
        if (findingId) await convexMutation("findings:markWoven", { ids: [findingId] }).catch(() => {});
        const weaveThread = await chatThread();
        await convexMutation("chatQueue:postAssistant", { threadId: weaveThread, text: spoken });
        // The full answer lands as a tappable card in the stream AND on the big
        // screen — "reporting back" means Daniel can actually read the findings.
        if (result && result.length > 40 && !cloneFailed) {
          const title = `finding · ${job.task.slice(0, 44).replace(/\s+/g, " ")}`;
          await convexMutation("chatQueue:postCard", {
            threadId: weaveThread,
            type: "markdown",
            value: result.slice(0, 3900),
            title,
          }).catch(() => {});
          await convexMutation("ui:setPanel", {
            type: "markdown",
            value: result.slice(0, 7000),
            title,
          }).catch(() => {});
        }
        await sendPush("JARVIS", spoken.slice(0, 140), "/");
      } catch (e: any) {
        await convexMutation("jobs:finalize", { jobId: job.jobId, status: "error", result: String(e?.message ?? e) });
        if (job.incidentId)
          await convexMutation("incidents:setStatus", { id: job.incidentId, status: "open" }).catch(() => {});
        if (job.missionId) await maybeSynthesizeMission(job.missionId).catch(() => {});
        else
          await convexMutation("chatQueue:postAssistant", {
            threadId: await chatThread(),
            text: `⚠️ Agent failed: ${String(e?.message ?? e).slice(0, 300)}`,
          }).catch(() => {});
      }
    };

    // When the LAST fleet agent lands, merge everything into one report.
    // missions:checkComplete is atomic — exactly one runner wins the synthesis.
    const maybeSynthesizeMission = async (missionId: string): Promise<void> => {
      const synth: any = await convexMutation("missions:checkComplete", { id: missionId }).catch(() => null);
      if (!synth) return;
      const failedAll = synth.results.every((r: any) => r.status === "error");
      const body = synth.results
        .map((r: any) => `### ${r.label} [${r.status}]\n${r.result || "(no output)"}`)
        .join("\n\n");
      const merged = await runClaude(
        bin,
        "/tmp/work",
        env,
        `You are JARVIS's mission synthesizer. A fleet of agents just finished parallel work on ONE mission. ` +
          `Merge their results into a single coherent markdown report: start with "## Mission" and a 2-sentence outcome, ` +
          `then "## Findings" (the substance, deduplicated, agent labels only where they add clarity), then "## Next moves" ` +
          `(concrete recommended actions). Be direct; flag agents that failed. Under 500 words.\n\n` +
          `MISSION: ${synth.goal}\n\nAGENT RESULTS:\n${body.slice(0, 24000)}`,
        "sonnet",
      );
      const report = merged && !/^error:/.test(merged) && merged !== "(no output)" ? merged : `## Mission\n${synth.goal}\n\n${body.slice(0, 6000)}`;
      await convexMutation("missions:finish", { id: missionId, summary: report.slice(0, 4000), failed: failedAll });
      const thread = await chatThread();
      const spoken =
        (await weaveLine(bin, env, `MISSION: ${synth.goal}`, report)) ||
        (failedAll ? "The fleet came back empty-handed, sir — mission report is on your screen." : "Mission complete, sir — the fleet's full report is on your screen.");
      await convexMutation("chatQueue:postAssistant", { threadId: thread, text: spoken });
      await convexMutation("chatQueue:postCard", {
        threadId: thread,
        type: "markdown",
        value: report.slice(0, 3900),
        title: `mission · ${synth.goal.slice(0, 44)}`,
      }).catch(() => {});
      await convexMutation("ui:setPanel", { type: "markdown", value: report.slice(0, 7000), title: `mission · ${synth.goal.slice(0, 44)}` }).catch(() => {});
      await sendPush("JARVIS — mission complete", synth.goal.slice(0, 120), "/");
    };

    // Claim window must leave room for a full agent run inside the task
    // ceiling. Fleet missions run CONCURRENTLY (cap 3 — each agent is a full
    // claude process; the box has headroom for three).
    const CONCURRENCY = 3;
    const inFlight = new Set<Promise<void>>();
    while (Date.now() - started < 120_000) {
      if (inFlight.size >= CONCURRENCY) {
        await Promise.race(inFlight);
        continue;
      }
      const job: any = await convexMutation("jobs:claimNext", {});
      if (!job) {
        if (inFlight.size === 0) break;
        await Promise.race(inFlight);
        continue;
      }
      processed += 1;
      let p: Promise<void>;
      // eslint-disable-next-line prefer-const
      p = processJob(job).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    await Promise.all([...inFlight]);
    return { processed };
  },
});
