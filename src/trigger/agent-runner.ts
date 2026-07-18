import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendPush } from "./push-send";
import { INFRA_MAP } from "../lib/persona";
import { routeWork } from "../mastra/routing";
import { TEAM_BY_SLUG, type AgentSlug } from "../mastra/team";
import { codexExecPrefix, codexModelFor, normalizeReasoningEffort } from "./model-policy";
import { normalizeWorkModelTier } from "../lib/work-models";
import { githubGitEnv, githubRepoUrl } from "./git-transport";
import { vaultService } from "../lib/vault-client";
import { buildContinuationCheckpoint, segmentTimeoutMs } from "./continuation";
import { runWatchSweep } from "./watch-runtime";
import {
  missingSubscriptionTools,
  isolateSubscriptionEnv,
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  type AgentProvider,
} from "./subscription-runtime";
import { runConcurrentClaimLoop } from "./agent-pool";
import { parseGoalPlan, parseGoalValidation, type GoalPlan } from "../lib/goal-mode";

// Slice D — dispatch. Claims background jobs, runs the routed subscription
// agent in an isolated workspace (with optional repository and scoped MCP
// access), then weaves the reviewed result back into the originating thread.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const APP_FACTORY_CONVEX_URL =
  process.env.APP_FACTORY_CONVEX_URL ?? "https://successful-starling-140.eu-west-1.convex.cloud";

function promptArgs(prompt: string, tier: string, json = false, mcpConfig?: string | null, reasoningEffort?: unknown): string[] {
  const args = codexExecPrefix(tier, reasoningEffort);
  if (json) args.push("--json");
  if (mcpConfig) {
    try {
      const cfg = JSON.parse(readFileSync(mcpConfig, "utf8")) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };
      for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
        args.push("--config", `mcp_servers.${name}.command=${JSON.stringify(server.command)}`);
        if (server.args) args.push("--config", `mcp_servers.${name}.args=${JSON.stringify(server.args)}`);
        if (server.env) args.push("--config", `mcp_servers.${name}.env=${JSON.stringify(server.env)}`);
      }
    } catch { /* run without an invalid optional MCP config */ }
  }
  args.push(prompt);
  return args;
}

function plainPrompt(bin: string, env: NodeJS.ProcessEnv, prompt: string, tier: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(bin, promptArgs(prompt, tier), { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve(output); }, timeoutMs);
    p.stdout.on("data", (d) => (output += d.toString()));
    p.on("close", () => { clearTimeout(timer); resolve(output); });
    p.on("error", () => { clearTimeout(timer); resolve(""); });
  });
}
async function convexMutation(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const protectedArgs = { ...((args ?? {}) as Record<string, unknown>), workerToken };
  const response = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error") {
    throw new Error(`Convex mutation ${path} failed: ${String(payload?.errorMessage ?? response.status).slice(0, 400)}`);
  }
  return payload.value;
}
async function convexQuery(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  try {
    return (
      await (
        await fetch(`${CONVEX_URL}/api/query`, {
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

async function appFactoryCall(kind: "query" | "mutation", path: string, args: Record<string, unknown>) {
  const response = await fetch(`${APP_FACTORY_CONVEX_URL.replace(/\/$/, "")}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error") {
    throw new Error(`App Factory ${path} failed: ${String(payload?.errorMessage ?? response.status).slice(0, 400)}`);
  }
  return payload.value;
}

async function startAppFactoryGoal(plan: GoalPlan, missionId: string) {
  if (!plan.factory) throw new Error("The Sol plan omitted the required App Factory build brief");
  const suffix = missionId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase();
  const baseSlug = plan.factory.slug.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "new-app";
  const slug = `${baseSlug}-${suffix}`.slice(0, 50);
  const existing: any = await appFactoryCall("query", "apps:bySlug", { slug });
  if (existing?._id) return { kind: "app-factory", id: String(existing._id), slug };
  const id = await appFactoryCall("mutation", "apps:create", {
    slug,
    name: plan.factory.name,
    oneLiner: plan.summary.slice(0, 120),
    idea: plan.factory.brief,
    origin: "daniel",
    priority: 100,
  });
  if (!id) throw new Error("App Factory did not return a live app id");
  return { kind: "app-factory", id: String(id), slug };
}

async function syncExternalGoalRuns() {
  const rows: any[] = (await convexQuery("goalMode:externalPending", {})) ?? [];
  let updated = 0;
  for (const row of rows.slice(0, 20)) {
    if (row.externalKind !== "app-factory" || !row.externalRunId) continue;
    try {
      const app: any = await appFactoryCall("query", "apps:get", { id: row.externalRunId });
      if (!app) throw new Error("App Factory run no longer exists");
      const ok = await convexMutation("goalMode:updateExternal", {
        id: row.id,
        status: String(app.status ?? "unknown"),
        stage: String(app.stage ?? "unknown"),
        stageState: app.stageState ? String(app.stageState) : undefined,
        detail: app.lastError ? String(app.lastError).slice(0, 1_500) : undefined,
      });
      if (ok) updated += 1;
    } catch {
      // A temporary provider failure must not rewrite durable goal state. The
      // next scheduled cloud harness retries the same external id.
    }
  }
  return updated;
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

// Sub-agent model routing uses the same Codex subscription tiers as the
// conversational supervisor.
function pickAgentModel(task: string): string {
  return routeWork(task).model;
}


// MCP servers the brain can attach on demand. Browserbase = hosted browsers
// (no local Chromium in the Trigger image); context7 = live library docs.
async function buildMcpConfig(names: string[], jobKey: string): Promise<string | null> {
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
  const path = `/tmp/work/mcp-${jobKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
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
  const out = await plainPrompt(bin, env, prompt, "luna", 60_000);
  const line = out.trim().replace(/\s+/g, " ").replace(/[*#`_]/g, "");
  return line.length > 4 && line.length < 400 ? line : "";
}

// JARVIS checks every finished job with the balanced tier: did the work
// actually meet its definition of done, is anything off, or did the agent stop
// on a question JARVIS can answer itself? A missing/negative verdict can never
// be promoted to "verified" by the Convex finalization invariant.
async function verifyWork(
  bin: string,
  env: NodeJS.ProcessEnv,
  task: string,
  result: string,
): Promise<{ verdict: "pass" | "concerns" | "needs_input"; note: string; answer: string } | null> {
  const prompt =
    "You are JARVIS quickly verifying a background agent's finished work. Reply with ONLY minified JSON: " +
    '{"verdict":"pass"|"concerns"|"needs_input","note":"<one short sentence>","answer":"<only for needs_input: your answer/decision if YOU can make it from context, else empty>"} ' +
    "verdict rules: pass = work matches the task and looks complete; concerns = done but something specific looks wrong/unfinished (say what in note); " +
    "needs_input = the agent stopped on a question or decision. If that question is answerable with common sense or the task's own context, fill answer so the run can continue autonomously; leave answer empty only when Daniel genuinely must decide (money, accounts, personal preferences).\n\n" +
    `Task: ${task.slice(0, 800)}\n\nAgent result:\n${result.slice(0, 4000)}`;
  const out = await plainPrompt(bin, env, prompt, "terra", 90_000);
  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!["pass", "concerns", "needs_input"].includes(j.verdict)) return null;
    return { verdict: j.verdict, note: String(j.note ?? "").slice(0, 240), answer: String(j.answer ?? "").slice(0, 500) };
  } catch {
    return null;
  }
}

function runAgent(
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  model: string,
  onProgress?: (s: string, log?: string, stage?: string, percent?: number) => void,
  mcpConfig?: string | null,
  executionState?: () => Promise<string>,
  timeoutMs = 900_000,
  reasoningEffort?: unknown,
): Promise<{ text: string; timedOut: boolean; stopped: "paused" | "cancelled" | null; checkpointLog: string }> {
  return new Promise((resolve) => {
    const args = promptArgs(prompt, model, true, mcpConfig, reasoningEffort);
    const codexSelection = codexModelFor(model);
    const runtimeLabel = `${codexSelection.model} · ${normalizeReasoningEffort(reasoningEffort, codexSelection.effort)}`;
    const p = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    let finalText = "";
    let latest = "starting up…";
    let stage = "starting";
    let percent = 4;
    let workUnits = 0;
    let dirty = false;
    let settled = false;
    // full session transcript tail — streamed into the job row so the pill's
    // live view shows the agent actually working, not one opaque line
    const logLines: string[] = [];
    const pushLog = (line: string) => {
      logLines.push(line);
      if (logLines.length > 120) logLines.shift();
      dirty = true;
    };
    let lastHeartbeat = Date.now();
    const timer = onProgress
      ? setInterval(() => {
          if (dirty || Date.now() - lastHeartbeat >= 30_000) {
            dirty = false;
            lastHeartbeat = Date.now();
            onProgress(latest, logLines.join("\n").slice(-12_000), stage, percent);
          }
        }, 1500)
      : null;
    const finish = (timedOut: boolean, stopped: "paused" | "cancelled" | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      if (timer) clearInterval(timer);
      if (controlTimer) clearInterval(controlTimer);
      resolve({
        text: finalText || (timedOut ? "(agent segment timed out)" : stopped ? `(agent ${stopped})` : "(no output)"),
        timedOut,
        stopped,
        checkpointLog: logLines.join("\n").slice(-12_000),
      });
    };
    const to = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(true);
    }, timeoutMs); // bounded below Trigger's one-hour task ceiling
    let controlBusy = false;
    const controlTimer = executionState
      ? setInterval(async () => {
          if (controlBusy || settled) return;
          controlBusy = true;
          try {
            const state = await executionState();
            if (state === "paused" || state === "cancelled") {
              try {
                p.kill("SIGTERM");
                setTimeout(() => {
                  if (p.exitCode === null) p.kill("SIGKILL");
                }, 3000);
              } catch {
                /* already gone */
              }
              finish(false, state);
            }
          } finally {
            controlBusy = false;
          }
        }, 12_000)
      : null;
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
        if (ev.type === "thread.started") {
          latest = `session started · ${runtimeLabel}`;
          stage = "understanding";
          percent = Math.max(percent, 8);
          pushLog(`▸ ${runtimeLabel} session started`);
        } else if (ev.type === "item.started" && ev.item?.type === "command_execution") {
          latest = `Running ${String(ev.item.command ?? "command").slice(0, 120)}`;
          stage = "executing";
          workUnits += 1;
          percent = Math.max(percent, Math.min(78, 14 + workUnits * 5));
          pushLog(`▸ ${latest}`);
        } else if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          if (typeof ev.item.text === "string") {
            finalText = ev.item.text;
            latest = ev.item.text.trim().replace(/\s+/g, " ").slice(-160);
            stage = "reviewing";
            percent = Math.max(percent, 84);
            pushLog(ev.item.text.trim().slice(0, 400));
          }
        } else if (ev.type === "assistant" && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === "tool_use") {
              latest = `Using ${b.name}${b.input?.command ? ": " + String(b.input.command).slice(0, 80) : b.input?.file_path ? ": " + b.input.file_path : ""}`;
              stage = "executing";
              workUnits += 1;
              percent = Math.max(percent, Math.min(78, 14 + workUnits * 5));
              pushLog(`▸ ${b.name}${b.input?.command ? "  $ " + String(b.input.command).slice(0, 140) : b.input?.file_path ? "  " + String(b.input.file_path).slice(0, 140) : ""}`);
            } else if (b.type === "text" && b.text?.trim()) {
              latest = b.text.trim().replace(/\s+/g, " ").slice(-160);
              stage = "reasoning";
              percent = Math.max(percent, Math.min(80, 18 + workUnits * 5));
              pushLog(b.text.trim().slice(0, 400));
            }
          }
        } else if (ev.type === "result" && typeof ev.result === "string") {
          finalText = ev.result;
          stage = "reviewing";
          percent = Math.max(percent, 88);
        } else if (ev.type === "turn.failed" || ev.type === "error") {
          const message = String(ev.error?.message ?? ev.message ?? ev.error ?? "agent turn failed").slice(0, 2000);
          finalText = `error: ${message}`;
          latest = message.slice(-180);
          stage = "error";
          pushLog(`! ${message}`);
        }
      }
    });
    p.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-4000);
      const line = data.toString().trim().replace(/\s+/g, " ").slice(-180);
      if (line) {
        latest = line;
        pushLog(`! ${line}`);
      }
    });
    p.on("close", (code) => {
      if (code !== 0 && !finalText) finalText = `error: ${stderr.trim() || `agent exited ${code}`}`;
      finish(false);
    });
    p.on("error", (e) => {
      finalText = "error: " + e.message;
      finish(false);
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

function workBranch(job: any): string {
  if (typeof job.branch === "string" && /^jarvis\/[a-z0-9._/-]+$/i.test(job.branch)) return job.branch;
  const owner = String(job.agentId ?? "agent").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const label = String(job.label ?? job.task ?? "work")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 34);
  return `jarvis/${owner}-${label || "work"}-${String(job.jobId).slice(-6)}`;
}

async function openDraftPullRequest(
  repo: string,
  branch: string,
  title: string,
  body: string,
  token: string,
): Promise<string | null> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
  try {
    const [owner] = repo.split("/");
    const existing = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      { headers },
    );
    if (existing.ok) {
      const rows = (await existing.json()) as { html_url?: string }[];
      if (rows[0]?.html_url) return rows[0].html_url;
    }
    const metadata = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    const base = metadata.ok ? String(((await metadata.json()) as any).default_branch ?? "main") : "main";
    const created = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: title.slice(0, 120),
        head: branch,
        base,
        body: body.slice(0, 4000),
        draft: true,
      }),
    });
    if (!created.ok) return null;
    return String(((await created.json()) as any).html_url ?? "") || null;
  } catch {
    return null;
  }
}

async function branchHasChanges(repo: string, branch: string, token: string): Promise<boolean | null> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  try {
    const metadata = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!metadata.ok) return null;
    const base = String(((await metadata.json()) as any).default_branch ?? "main");
    const comparison = await fetch(
      `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`,
      { headers },
    );
    if (!comparison.ok) return null;
    const result = (await comparison.json()) as { ahead_by?: number; status?: string };
    return Number(result.ahead_by ?? 0) > 0 && result.status !== "identical";
  } catch {
    return null;
  }
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

// The actual specialist runtime is a subscription-authenticated CLI harness.
// It is exported independently of Trigger so cloud runners can execute the
// same durable lease/checkpoint protocol with their repository-scoped tools.
export async function runAgentHarness() {
    const provider: AgentProvider = "codex";
    const bin = resolveSubscriptionAgentBin(provider);
    if (!bin) return { processed: 0, error: `no ${provider} binary` };
    const prepared = prepareSubscriptionEnv(provider);
    if (prepared.error) return { processed: 0, error: prepared.error };
    const missingTools = missingSubscriptionTools(prepared.env);
    if (missingTools.length) {
      return {
        processed: 0,
        error: `Codex worker toolchain unavailable: missing ${missingTools.join(", ")} on PATH`,
      };
    }

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
        const repairJobId = await convexMutation("jobs:enqueue", {
          task: repairPrompt(inc, repo),
          repo,
          model: "sol",
          modelReason: "Paul uses the highest tier for production root-cause repair",
          agentId: "paul",
          risk: "high",
          priority: 90,
          originThreadId: await chatThread(),
          visibility: "system",
          acceptanceCriteria: [
            "Reproduce or evidence the root cause before editing",
            "Implement the smallest safe repair on an isolated branch",
            "Verify the relevant build or live surface and report evidence",
          ],
          incidentId: String(inc.id),
        });
        if (repairJobId) {
          await convexMutation("incidents:linkJob", { id: inc.id, jobId: String(repairJobId) }).catch(() => {});
        }
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
    // Timed reminders: deliver anything due as a push + a spoken weave.
    try {
      const due: any[] = (await convexMutation("reminders:due", {})) ?? [];
      for (const r of due) {
        const mins = Math.round((Date.now() - r.at) / 60000);
        const late = mins > 4 ? ` (set for ${new Date(r.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })})` : "";
        await convexMutation("chatQueue:postAssistant", {
          threadId: await chatThread(),
          text: `⏰ Reminder, sir — ${r.text}${late}`,
        }).catch(() => {});
        const reminderTag = `reminder-${String(r._id).slice(-20)}`;
        await sendPush(
          "⏰ JARVIS reminder",
          String(r.text).slice(0, 140),
          "/",
          { tag: reminderTag, topic: reminderTag, ttl: 3600, urgency: "high" },
        ).catch(() => {});
        await convexMutation("reminders:complete", { id: r._id }).catch(() => {});
      }
    } catch {
      /* reminders must never block jobs either */
    }
    // Indexed, leased price/asset rules. One observation is shared by every
    // threshold on the same subject; Convex commits true crossings atomically.
    try {
      await runWatchSweep();
    } catch {
      /* watches never block jobs */
    }
    const env = prepared.env;
    mkdirSync("/tmp/work", { recursive: true });
    const token = process.env.GITHUB_TOKEN ?? "";

    // Standing briefing every agent reads from the Codex home:
    // Daniel's infra map + vault access + repo/deploy conventions = real project access.
    const briefingPath = join(String(env.CODEX_HOME), "AGENTS.md");
    writeFileSync(
      briefingPath,
      `# You are a scoped JARVIS permanent-team agent working for Daniel.\n\n${INFRA_MAP}\n\n` +
        `## Capability boundary\n` +
        `You run inside an isolated worktree with no general secrets-vault access. Use only the repository and explicitly attached MCP capabilities. Never seek credentials, publish, message people, spend money, or perform destructive/production actions. If one is required, stop with the exact approval needed.\n\n` +
        `## Conventions\n- The runner supplies the repository when one is in scope; do not clone or push another repository.\n` +
        `- Toolchain: curl, git, node, npm, npx and gh were verified before this lease. Use them through Codex's shell tool. Live web search is enabled for current information.\n` +
        `- The repository is already checked out for you. GitHub credentials remain with the delivery controller; use gh only for public/read-only inspection and report if a remote authenticated operation is required.\n` +
        `- Never invent results. If something is inaccessible, say so plainly in your final answer.\n` +
        `- Final answer style: plain text, the key outcome first, under 300 words.\n`,
    );

    let processed = 0;
    const failureBackoffMs = (attempt: number) =>
      Math.min(6 * 60 * 60 * 1000, 60_000 * 2 ** Math.max(0, Math.min(12, attempt - 1)));

    const drainGoalAdvances = async (): Promise<number> => {
      let advanced = 0;
      for (let index = 0; index < 12; index += 1) {
        const claim: any = await convexMutation("goalMode:claimAdvance", {}).catch(() => null);
        if (!claim) break;
        if (claim.kind === "advanced") {
          advanced += 1;
          continue;
        }
        if (claim.kind === "plan") {
          let plan: GoalPlan;
          try {
            plan = parseGoalPlan(String(claim.result ?? ""), Number(claim.maxBuildSessions ?? 6));
            plan.route = claim.route || plan.route;
            plan.primaryRepo = claim.primaryRepo || plan.primaryRepo;
          } catch (error) {
            await convexMutation("goalMode:rejectAdvance", {
              id: claim.missionId,
              jobId: claim.jobId,
              expectedAdvanceAttempt: Number(claim.expectedAdvanceAttempt),
              error: String(error),
            }).catch(() => null);
            advanced += 1;
            continue;
          }
          let externalRun: { kind: string; id: string; slug?: string } | undefined;
          if (claim.route === "app_factory") {
            try {
              externalRun = await startAppFactoryGoal(plan, String(claim.missionId));
            } catch (error) {
              await convexMutation("goalMode:releaseAdvance", {
                id: claim.missionId,
                expectedAdvanceAttempt: Number(claim.expectedAdvanceAttempt),
                error: String(error),
                delayMs: 60_000,
              }).catch(() => null);
              break;
            }
          }
          const result: any = await convexMutation("goalMode:recordPlan", {
            id: claim.missionId,
            expectedAdvanceAttempt: Number(claim.expectedAdvanceAttempt),
            plan,
            externalRun,
          }).catch(() => null);
          if (result?.advanced) {
            advanced += 1;
            const thread = await chatThread();
            const line = result.external
              ? `I have locked the Sol architecture and handed the build to App Factory ${externalRun?.slug ? `as ${externalRun.slug}` : ""}. I am monitoring every stage and will stop at its human gates.`
              : `I have locked the Sol architecture. ${result.jobs} Terra/high sessions are now working through it on one durable goal branch; the final Sol review cannot pass without deep evidence.`;
            await convexMutation("chatQueue:postAssistant", { threadId: thread, text: line }).catch(() => {});
          }
          continue;
        }
        if (claim.kind === "validation") {
          let validation;
          try {
            validation = parseGoalValidation(String(claim.result ?? ""));
          } catch (error) {
            await convexMutation("goalMode:rejectAdvance", {
              id: claim.missionId,
              jobId: claim.jobId,
              expectedAdvanceAttempt: Number(claim.expectedAdvanceAttempt),
              error: String(error),
            }).catch(() => null);
            advanced += 1;
            continue;
          }
          const result: any = await convexMutation("goalMode:recordValidation", {
            id: claim.missionId,
            expectedAdvanceAttempt: Number(claim.expectedAdvanceAttempt),
            validation,
          }).catch(() => null);
          if (!result?.advanced) continue;
          advanced += 1;
          if (result.status === "done") {
            const thread = await chatThread();
            const report = [
              `## Goal achieved\n${validation.summary}`,
              validation.evidence.length ? `## Validation evidence\n${validation.evidence.map((item: string) => `- ${item}`).join("\n")}` : "",
              validation.gaps.length ? `## Remaining notes\n${validation.gaps.map((item: string) => `- ${item}`).join("\n")}` : "",
            ].filter(Boolean).join("\n\n");
            const spoken = (await weaveLine(bin, env, "LONG-RUNNING GOAL COMPLETED", report)) || "The goal has passed its final Sol validation. The evidence is on your screen.";
            await convexMutation("chatQueue:postAssistant", { threadId: thread, text: spoken }).catch(() => {});
            await convexMutation("chatQueue:postCard", {
              threadId: thread,
              type: "markdown",
              value: report.slice(0, 3_900),
              title: "Goal Mode · validated outcome",
            }).catch(() => {});
            await sendPush("JARVIS — goal achieved", validation.summary.slice(0, 120), "/").catch(() => {});
          } else if (result.status === "needs_input") {
            const thread = await chatThread();
            await convexMutation("chatQueue:postAssistant", {
              threadId: thread,
              text: `The deep validator found a boundary I cannot cross honestly: ${String(result.reason ?? validation.summary).slice(0, 320)} I have preserved every checkpoint in Goal Mode.`,
            }).catch(() => {});
            await sendPush("JARVIS needs your decision", String(result.reason ?? validation.summary).slice(0, 120), "/").catch(() => {});
          }
        }
      }
      return advanced;
    };

    // One permanent agent's lifecycle: clone an isolated branch, execute one
    // bounded segment, checkpoint or verify, then report to the originating
    // conversation. Mission jobs remain quiet until the reviewed synthesis.
    const processJob = async (job: any): Promise<void> => {
      const originThread = typeof job.originThreadId === "string" && job.originThreadId ? job.originThreadId : "main";
      const expectedAttempt = Number(job.attempt ?? 1);
      const executionStatus = async (): Promise<string> => {
        const lease: any = await convexQuery("jobs:executionLease", { jobId: job.jobId });
        if (!lease || Number(lease.attempt) !== expectedAttempt) return "superseded";
        return String(lease.status ?? "missing");
      };
      const stopIfLeaseLost = async (checkpoint: string, result: string, branch?: string | null): Promise<boolean> => {
        const state = await executionStatus();
        if (state === "running") return false;
        if (state === "paused" || state === "cancelled") {
          await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            expectedAttempt,
            checkpoint,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
            nextStatus: state,
          }).catch(() => null);
        }
        return true;
      };
      try {
        const jobKey = String(job.jobId).replace(/[^a-zA-Z0-9_-]/g, "_");
        const jobEnv = isolateSubscriptionEnv(env, `${jobKey}-attempt-${expectedAttempt}`);
        let cwd = `/tmp/work/scratch-${jobKey}`;
        mkdirSync(cwd, { recursive: true });
        const agentId = (TEAM_BY_SLUG[job.agentId as AgentSlug] ? job.agentId : routeWork(job.task, { repo: job.repo }).agentId) as AgentSlug;
        const profile = TEAM_BY_SLUG[agentId];
        let context = "This is a read-only knowledge/research run. Do not edit local files or mutate external systems.";
        let repoDir: string | null = null;
        const repo = resolveRepo(job.repo);
        const branch = repo && !job.readonly ? workBranch({ ...job, agentId }) : null;
        let baseSha = "";
        let cloneFailed = false;
        if (repo && token) {
          const dir = `/tmp/work/${repo.replace(/[^a-zA-Z0-9]/g, "_")}_${jobKey}`;
          rmSync(dir, { recursive: true, force: true });
          const url = githubRepoUrl(repo);
          const gitEnv = githubGitEnv(env, token);
          if (job.branch) {
            await sh("git", ["clone", "--depth", "1", "--single-branch", "--branch", String(job.branch), url, dir], gitEnv);
          }
          if (!existsSync(join(dir, ".git"))) {
            rmSync(dir, { recursive: true, force: true });
            await sh("git", ["clone", "--depth", "1", url, dir], gitEnv);
          }
          if (existsSync(join(dir, ".git"))) {
            cwd = dir;
            repoDir = dir;
            // Defense in depth: the subprocess only ever sees a credential-free
            // remote even if Git changes clone credential persistence behavior.
            await sh("git", ["-C", dir, "remote", "set-url", "origin", url], env);
            await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
            await sh("git", ["-C", dir, "config", "user.name", `${profile.name} via JARVIS`], env);
            baseSha = (await sh("git", ["-C", dir, "rev-parse", "HEAD"], env)).out.trim();
            if (branch) await sh("git", ["-C", dir, "checkout", "-B", branch], env);
            if (branch)
              await convexMutation("jobs:setDelivery", {
                jobId: job.jobId,
                expectedAttempt,
                branch,
              }).catch(() => {});
            context = job.readonly
              ? `Your working directory is a read-only checkout of ${repo}. Inspect it deeply, but do not edit or commit.`
              : `Your working directory is an isolated checkout of ${repo} on branch ${branch}. Actually perform the scoped task. You may edit and commit here; never push, merge, deploy, or switch branches because the runner owns delivery.`;
          } else {
            cloneFailed = true;
            context = `The scoped repository ${repo} could not be cloned. Do not pretend you edited it. State the access/repository failure and what remains blocked.`;
          }
        } else if (repo && !token) {
          cloneFailed = true;
          context = `Repository work was requested for ${repo}, but the runner has no GitHub transport credential. Do not pretend the repository was changed.`;
        }
        if (await stopIfLeaseLost("Execution stopped while preparing the secure workspace.", "", branch)) return;
        const criteria = Array.isArray(job.acceptanceCriteria) && job.acceptanceCriteria.length
          ? job.acceptanceCriteria.map(String)
          : ["Deliver the requested outcome with concrete evidence"];
        const checkpoint = job.checkpoint
          ? `\n\nCONTINUATION CHECKPOINT (attempt ${job.attempt ?? 1}; preserve completed work, do not start over):\n${String(job.checkpoint).slice(0, 6000)}`
          : "";
        const followUp = job.parentJobId
          ? `\n\nCONCURRENT FOLLOW-UP: this job extends ${job.parentJobId}. That earlier job may still be running. Own this issue independently; do not wait for it or overwrite its branch.`
          : "";
        const prompt =
          `You are ${profile.name}, JARVIS's permanent ${profile.role}.\n${profile.instructions}\n\n${context}\n\n` +
          `TASK:\n${job.task}\n\nDEFINITION OF DONE:\n${criteria.map((item: string) => `- ${item}`).join("\n")}` +
          `${checkpoint}${followUp}\n\nBefore finishing, verify the definition of done and explicitly report the evidence. If a consequential action or personal decision is required, stop and ask one precise question.`;
        const model = normalizeWorkModelTier(
          typeof job.model === "string" && job.model ? job.model : pickAgentModel(job.task),
        );
        const mcpConfig = Array.isArray(job.mcp) && job.mcp.length ? await buildMcpConfig(job.mcp, jobKey) : null;
        const run = await runAgent(
          bin,
          cwd,
          jobEnv,
          prompt,
          model,
          (line, log, stage, percent) => {
            void convexMutation("jobs:updateProgress", {
              jobId: job.jobId,
              expectedAttempt,
              progress: line,
              log,
              stage,
              percent,
            });
          },
          mcpConfig,
          async () => {
            const state = await executionStatus();
            return state === "superseded" ? "cancelled" : state;
          },
          segmentTimeoutMs(model),
          job.reasoningEffort,
        );
        const result = run.text;

        const checkpointText = buildContinuationCheckpoint({
          attempt: expectedAttempt,
          timedOut: run.timedOut,
          stopped: run.stopped,
          priorCheckpoint: job.checkpoint,
          narrative: result,
          trace: run.checkpointLog,
        });
        if (run.stopped) {
          await stopIfLeaseLost(checkpointText, result, branch);
          return;
        }
        if (await stopIfLeaseLost(checkpointText, result, branch)) return;

        let pushNote = "";
        let pushFailed = false;
        let changed = false;
        if (repoDir && token && branch && !job.readonly) {
          const pushUrl = githubRepoUrl(repo);
          const gitEnv = githubGitEnv(env, token);
          await sh("git", ["-C", repoDir, "add", "-A"], env);
          await sh(
            "git",
            ["-C", repoDir, "commit", "-m", `chore: ${profile.name.toLowerCase()} — ${job.task.slice(0, 60).replace(/"/g, "'")}`],
            env,
          );
          const local = (await sh("git", ["-C", repoDir, "rev-parse", "HEAD"], env)).out.trim();
          const remote = (await sh("git", ["-C", repoDir, "ls-remote", pushUrl, `refs/heads/${branch}`], gitEnv)).out.split(/\s/)[0]?.trim();
          const needsPush = Boolean(local && local !== (remote || baseSha));
          if (!needsPush) {
            pushNote = remote ? `existing checkpoint branch ${branch} retained` : "no repository changes were needed";
          } else {
            if (await stopIfLeaseLost(checkpointText, result, branch)) return;
            let push = await sh("git", ["-C", repoDir, "push", pushUrl, `HEAD:refs/heads/${branch}`], gitEnv);
            if (/shallow update not allowed/i.test(push.out)) {
              await sh("git", ["-C", repoDir, "fetch", "--unshallow"], gitEnv);
              push = await sh("git", ["-C", repoDir, "push", pushUrl, `HEAD:refs/heads/${branch}`], gitEnv);
            }
            pushFailed = push.code !== 0;
            pushNote = pushFailed
              ? `branch push failed: ${push.out.slice(-180).replace(/\s+/g, " ")}`
              : `checkpoint branch ${branch} pushed`;
          }
          if (!pushFailed) {
            const compared = await branchHasChanges(repo, branch, token);
            changed = compared ?? (needsPush || Boolean(remote && job.branch));
            if (!changed && needsPush) pushNote = "branch matches the repository default after verification";
          }
        }

        const continuationCheckpoint = buildContinuationCheckpoint({
          attempt: expectedAttempt,
          timedOut: run.timedOut,
          stopped: run.stopped,
          priorCheckpoint: job.checkpoint,
          narrative: result,
          trace: run.checkpointLog,
          deliveryNote: pushNote,
        });
        const failedRun = /^error:/i.test(result) || result === "(no output)";
        if ((run.timedOut || failedRun) && !cloneFailed && !pushFailed) {
          const continuation = await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            expectedAttempt,
            checkpoint: continuationCheckpoint,
            result: (run.timedOut ? continuationCheckpoint : result).slice(0, 4000),
            branch: branch ?? undefined,
            delayMs: run.timedOut ? 5_000 : failureBackoffMs(Number(job.attempt ?? 1)),
          });
          if (continuation?.requeued) {
            if (!job.missionId)
              await convexMutation("chatQueue:postAssistant", {
                threadId: originThread,
                text: run.timedOut
                  ? `${profile.name} saved a checkpoint and is continuing the job in another segment — no work was lost.`
                  : `${profile.name} hit a recoverable snag, saved the evidence, and is retrying with a different approach.`,
              }).catch(() => {});
          } else if (job.missionId) {
            await maybeSynthesizeMission(job.missionId).catch(() => {});
          } else {
            await convexMutation("chatQueue:postAssistant", {
              threadId: originThread,
              text: `${profile.name} exhausted the continuation budget. I kept the checkpoints and marked the job honestly as failed.`,
            }).catch(() => {});
          }
          return;
        }

        if (cloneFailed || pushFailed) {
          const failure = cloneFailed ? `Could not access ${repo || "the repository"}. ${result}` : `${pushNote}\n\n${result}`;
          const finalized = await convexMutation("jobs:finalize", {
            jobId: job.jobId,
            expectedAttempt,
            status: "error",
            result: failure.slice(0, 4000),
          });
          if (!finalized) return;
          if (job.incidentId)
            await convexMutation("incidents:setStatus", { id: job.incidentId, status: "open" }).catch(() => {});
          if (job.missionId) await maybeSynthesizeMission(job.missionId).catch(() => {});
          else
            await convexMutation("chatQueue:postAssistant", {
              threadId: originThread,
              text: `${profile.name} could not complete that safely: ${failure.slice(0, 220)}`,
            }).catch(() => {});
          return;
        }

        if (job.goalStage === "planning" || job.goalStage === "validating") {
          try {
            if (job.goalStage === "planning") parseGoalPlan(result, 8);
            else parseGoalValidation(result);
          } catch (error) {
            await convexMutation("jobs:checkpointAndRequeue", {
              jobId: job.jobId,
              expectedAttempt,
              checkpoint:
                `The investigation completed, but the machine contract was invalid: ${String(error).slice(0, 1_000)}\n` +
                `Preserve the reasoning and return the required marker plus compact valid JSON. Do not redo discovery merely to repair formatting.`,
              result: result.slice(0, 4_000),
              branch: branch ?? undefined,
              delayMs: 5_000,
            }).catch(() => null);
            return;
          }
          const finalized = await convexMutation("jobs:finalize", {
            jobId: job.jobId,
            expectedAttempt,
            status: "done",
            result: result.slice(0, 4_000),
            verificationVerdict: "pass",
            verificationNote: `${job.goalStage === "planning" ? "Goal plan" : "Deep validation"} machine contract is structurally valid`,
          });
          if (finalized) await drainGoalAdvances();
          return;
        }

        await convexMutation("jobs:updateProgress", {
          jobId: job.jobId,
          expectedAttempt,
          progress: "JARVIS is reviewing the evidence",
          stage: "supervisor review",
          percent: 92,
        }).catch(() => {});
        const needsDaniel = /\b(need (your|daniel)|which (one|option)|please (confirm|choose|decide)|waiting on (you|daniel)|\?\s*$)/i.test(
          result.slice(-500),
        );
        const verify = await verifyWork(bin, jobEnv, job.task, result).catch(() => null);
        if (await stopIfLeaseLost(`Supervisor review interrupted.\n\n${continuationCheckpoint}`, result, branch)) return;
        if (!verify) {
          const continuation = await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            expectedAttempt,
            checkpoint:
              `The specialist completed this evidence, but JARVIS's supervisor returned no valid verdict. ` +
              `Re-check the definition of done and preserve the existing work:\n${result.slice(0, 5000)}`,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
            delayMs: failureBackoffMs(expectedAttempt),
          });
          if (!job.missionId && continuation?.requeued)
            await convexMutation("chatQueue:postAssistant", {
              threadId: originThread,
              text: `${profile.name} finished a pass, but my supervisor check was inconclusive. I saved everything and queued a fresh review instead of calling it verified.`,
            }).catch(() => {});
          else if (job.missionId && !continuation?.requeued)
            await maybeSynthesizeMission(job.missionId).catch(() => {});
          return;
        }
        if (verify.verdict === "concerns") {
          const continuation = await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            expectedAttempt,
            checkpoint:
              `Previous work:\n${result.slice(0, 4200)}\n\nJARVIS supervisor concern: ${verify.note || "The definition of done is not yet evidenced."}\nAddress this concern, re-run the relevant verification, and finish honestly.`,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
            delayMs: 5_000,
          });
          if (!job.missionId && continuation?.requeued)
            await convexMutation("chatQueue:postAssistant", {
              threadId: originThread,
              text: `${profile.name} returned work, but my review found a concrete gap: ${verify.note} I sent the checkpoint back for correction.`,
            }).catch(() => {});
          else if (job.missionId && !continuation?.requeued)
            await maybeSynthesizeMission(job.missionId).catch(() => {});
          return;
        }
        if (verify?.verdict === "needs_input" && verify.answer) {
          const continuation = await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            expectedAttempt,
            checkpoint:
              `Previous work:\n${result.slice(0, 4200)}\n\nThe specialist stopped on: ${verify.note}\nJARVIS's supervisor decision: ${verify.answer}\nContinue and finish; do not ask Daniel this ordinary implementation question again.`,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
            delayMs: 5_000,
          });
          if (!job.missionId)
            await convexMutation("chatQueue:postAssistant", {
              threadId: originThread,
              text: `${profile.name} hit an implementation choice; I made the call and sent the checkpoint back to finish.`,
            }).catch(() => {});
          else if (!continuation?.requeued)
            await maybeSynthesizeMission(job.missionId).catch(() => {});
          return;
        }
        if (verify?.verdict === "needs_input" || needsDaniel) {
          const question = verify?.note || result.slice(-500).trim() || "A personal or consequential decision is required.";
          await convexMutation("jobs:requestInput", {
            jobId: job.jobId,
            expectedAttempt,
            question,
            checkpoint: `Completed evidence:\n${result.slice(0, 4800)}\n\nWaiting on Daniel: ${question}`,
          });
          await convexMutation("chatQueue:postAssistant", {
            threadId: originThread,
            text: `Quick decision for ${profile.name}: ${question}`,
          }).catch(() => {});
          await sendPush("JARVIS needs your decision", question.slice(0, 140), "/").catch(() => {});
          return;
        }

        let pullRequestUrl: string | null = null;
        if (changed && repo && branch && token) {
          if (await stopIfLeaseLost(`Delivery interrupted.\n\n${continuationCheckpoint}`, result, branch)) return;
          pullRequestUrl = await openDraftPullRequest(
            repo,
            branch,
            `${profile.name}: ${(job.label ?? job.task).slice(0, 82)}`,
            `## JARVIS work order\n${job.task}\n\n## Acceptance criteria\n${criteria.map((item: string) => `- ${item}`).join("\n")}\n\n## Agent evidence\n${result}`,
            token,
          );
          await convexMutation("jobs:setDelivery", {
            jobId: job.jobId,
            expectedAttempt,
            branch,
            pullRequestUrl: pullRequestUrl ?? undefined,
          }).catch(() => {});
          pushNote = pullRequestUrl ? `draft PR ready: ${pullRequestUrl}` : `${pushNote}; draft PR creation needs review`;
        }
        const deliveryResult = `${result}${pushNote ? `\n\nDelivery: ${pushNote}` : ""}`;
        if (await stopIfLeaseLost(`Finalization interrupted.\n\n${continuationCheckpoint}`, deliveryResult, branch)) return;
        const finalized = await convexMutation("jobs:finalize", {
          jobId: job.jobId,
          expectedAttempt,
          status: "done",
          result: deliveryResult.slice(0, 4000),
          pullRequestUrl: pullRequestUrl ?? undefined,
          verificationVerdict: "pass",
          verificationNote: verify.note || "Supervisor check passed",
        });
        if (!finalized) return;
        if (job.incidentId)
          await convexMutation("incidents:setStatus", { id: job.incidentId, status: "resolved" }).catch(() => {});

        if (job.missionId) {
          if (job.goalStage) {
            await drainGoalAdvances();
            return;
          }
          const fleetFid = await convexMutation("findings:add", {
            source: job.task,
            spoken: `Fleet update: "${job.label ?? job.task.slice(0, 40)}" passed supervisor review.`,
            detail: deliveryResult.slice(0, 8000),
          }).catch(() => null);
          if (fleetFid) await convexMutation("findings:markWoven", { ids: [fleetFid] }).catch(() => {});
          await maybeSynthesizeMission(job.missionId);
          return;
        }

        let spoken =
          (await weaveLine(bin, jobEnv, job.task, deliveryResult)) ||
          `${profile.name} finished and JARVIS verified the evidence${pullRequestUrl ? "; a draft PR is ready for review" : ""}.`;
        spoken += " Supervisor check passed.";
        const findingId = await convexMutation("findings:add", {
          source: job.task,
          spoken,
          detail:
            (verify ? `[JARVIS verify: ${verify.verdict}${verify.note ? " — " + verify.note : ""}]\n\n` : "") +
            deliveryResult.slice(0, 8000),
        });
        if (findingId) await convexMutation("findings:markWoven", { ids: [findingId] }).catch(() => {});
        await convexMutation("chatQueue:postAssistant", { threadId: originThread, text: spoken });
        if (deliveryResult.length > 40) {
          await convexMutation("chatQueue:postCard", {
            threadId: originThread,
            type: "markdown",
            value: deliveryResult.slice(0, 3900),
            title: `finding · ${job.task.slice(0, 44).replace(/\s+/g, " ")}`,
          }).catch(() => {});
        }
        await sendPush("JARVIS", spoken.slice(0, 140), "/");
      } catch (e: any) {
        const message = String(e?.message ?? e);
        const recovered = await convexMutation("jobs:checkpointAndRequeue", {
          jobId: job.jobId,
          expectedAttempt,
          checkpoint: `Runner exception on attempt ${job.attempt ?? 1}: ${message.slice(0, 1200)}. Retry from the original task with a different approach.`,
          result: message.slice(0, 4000),
          branch: job.branch ?? undefined,
          delayMs: failureBackoffMs(Number(job.attempt ?? 1)),
        }).catch(() => null);
        if (job.incidentId)
          await convexMutation("incidents:setStatus", { id: job.incidentId, status: "open" }).catch(() => {});
        if (job.missionId && !recovered?.requeued) await maybeSynthesizeMission(job.missionId).catch(() => {});
        if (!job.missionId && !recovered?.requeued)
          await convexMutation("chatQueue:postAssistant", {
            threadId: originThread,
            text: `⚠️ ${job.agentId ?? "Agent"} exhausted its recovery budget: ${message.slice(0, 240)}`,
          }).catch(() => {});
      }
    };

    // When the last fleet agent lands—or a pending job is declined—the atomic
    // mission claim is merged exactly once into one reviewed report.
    const synthesizeMissionClaim = async (synth: any): Promise<void> => {
      if (!synth?.id) return;
      const missionId = String(synth.id);
      const failedAll = synth.results.every((r: any) => r.status !== "done");
      const body = synth.results
        .map((r: any) => `### ${r.label} [${r.status}]\n${r.result || "(no output)"}`)
        .join("\n\n");
      const merged = await runAgent(
        bin,
        "/tmp/work",
        env,
        `You are JARVIS's mission synthesizer. A fleet of agents just finished parallel work on ONE mission. ` +
          `Merge their results into a single coherent markdown report: start with "## Mission" and a 2-sentence outcome, ` +
          `then "## Findings" (the substance, deduplicated, agent labels only where they add clarity), then "## Next moves" ` +
          `(concrete recommended actions). Be direct; flag agents that failed. Under 500 words.\n\n` +
          `MISSION: ${synth.goal}\n\nAGENT RESULTS:\n${body.slice(0, 24000)}`,
        "terra",
      );
      const report = merged.text && !/^error:/.test(merged.text) && merged.text !== "(no output)"
        ? merged.text
        : `## Mission\n${synth.goal}\n\n${body.slice(0, 6000)}`;
      const finished = await convexMutation("missions:finish", {
        id: missionId,
        summary: report.slice(0, 4000),
        failed: failedAll,
        expectedSynthesisAttempt: Number(synth.synthesisAttempt),
      });
      if (!finished) return;
      const thread = typeof synth.originThreadId === "string" && synth.originThreadId ? synth.originThreadId : "main";
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
      await sendPush("JARVIS — mission complete", synth.goal.slice(0, 120), "/");
    };
    const maybeSynthesizeMission = async (missionId: string): Promise<void> => {
      await drainGoalAdvances();
      const synth: any = await convexMutation("missions:checkComplete", { id: missionId }).catch(() => null);
      if (synth) await synthesizeMissionClaim(synth);
    };

    // Each GitHub wake is a bounded three-process pool. Wake workflows may
    // overlap; Convex's atomic status+attempt lease prevents duplicate work.
    // A short idle drain catches jobs queued beside a mission without holding
    // an Actions runner open after the queue is empty.
    await syncExternalGoalRuns();
    await drainGoalAdvances();
    processed += await runConcurrentClaimLoop({
      capacity: 3,
      claimWindowMs: 120_000,
      idleDrainMs: 6_000,
      pollIntervalMs: 2_000,
      claim: () => convexMutation("jobs:claimNext", {}),
      run: processJob,
    });
    await syncExternalGoalRuns();
    await drainGoalAdvances();
    // Approval declines/cancellations do not run processJob, so sweep terminal
    // missions after normal work. Each claim flips running → synthesizing in
    // Convex, preventing another cron invocation from reporting it twice.
    for (let i = 0; i < 3; i += 1) {
      const ready: any = await convexMutation("missions:claimReady", {}).catch(() => null);
      if (!ready) break;
      await synthesizeMissionClaim(ready);
    }
  return { processed };
}

// Trigger remains a compatibility scheduler only. Production sets
// JARVIS_AGENT_RUNTIME=github, making this task incapable of claiming agent
// work; GitHub's isolated cloud runner invokes runAgentHarness directly.
export const agentRunner = schedules.task({
  id: "jarvis-agent-runner",
  cron: "* * * * *",
  machine: "micro",
  queue: { concurrencyLimit: 1 },
  maxDuration: 60,
  run: async () =>
    process.env.JARVIS_AGENT_RUNTIME === "trigger"
      ? runAgentHarness()
      : { processed: 0, runtime: "cli-harness", host: "github-actions" },
});
