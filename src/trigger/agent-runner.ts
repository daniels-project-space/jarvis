import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { sendPush } from "./push-send";
import { INFRA_MAP } from "../lib/persona";
import { routeWork } from "../mastra/routing";
import { TEAM_BY_SLUG, type AgentSlug } from "../mastra/team";

// Slice D — dispatch. Claims background jobs (enqueued by the brain), runs a
// Claude Code / Opus agent on them (optionally cloning a repo, committing +
// pushing changes, optionally with MCP servers attached), then WEAVES the result
// into conversation as one natural spoken line + a findings row (never a dump).

const nodeRequire = createRequire(import.meta.url);
const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

type AgentProvider = "codex" | "claude";

function resolveAgentBin(provider: AgentProvider): string | null {
  try {
    const packageName = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
    const command = provider === "codex" ? "codex" : "claude";
    const pkgJson = nodeRequire.resolve(`${packageName}/package.json`);
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", command)];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[command];
      if (rel) candidates.push(join(pkgDir, rel));
    } catch {
      /* ignore */
    }
    return candidates.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}

function prepareAgentEnv(provider: AgentProvider): { env: NodeJS.ProcessEnv; error?: string } {
  if (provider === "claude") {
    const home = "/tmp/claude-home";
    mkdirSync(join(home, ".claude"), { recursive: true });
    return { env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "", JARVIS_AGENT_PROVIDER: provider } };
  }
  const home = "/tmp/codex-home";
  mkdirSync(home, { recursive: true });
  const encoded = process.env.CODEX_AUTH_JSON_B64;
  const raw = process.env.CODEX_AUTH_JSON;
  if (encoded || raw) {
    try {
      const json = encoded ? Buffer.from(encoded, "base64").toString("utf8") : raw!;
      JSON.parse(json);
      const authPath = join(home, "auth.json");
      writeFileSync(authPath, json, { mode: 0o600 });
      chmodSync(authPath, 0o600);
    } catch {
      return { env: process.env, error: "invalid Codex subscription auth" };
    }
  }
  if (!process.env.CODEX_ACCESS_TOKEN && !encoded && !raw)
    return { env: process.env, error: "Codex subscription auth is not configured" };
  return {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: home,
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
      JARVIS_AGENT_PROVIDER: provider,
    },
  };
}

// Agent subprocesses receive only the credentials required to run the selected
// subscription CLI. GitHub and application/provider secrets stay in the runner
// control plane; MCP credentials are attached only when a scoped job requests
// that specific server.
function scopedAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "NODE_PATH",
    "NODE_OPTIONS",
    "SSL_CERT_FILE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_ACCESS_TOKEN",
    "JARVIS_AGENT_PROVIDER",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const key of allow) if (source[key] !== undefined) env[key] = source[key];
  env.ANTHROPIC_API_KEY = "";
  env.OPENAI_API_KEY = "";
  env.CODEX_API_KEY = "";
  return env;
}

const CODEX_MODELS: Record<string, { model: string; effort: string }> = {
  haiku: { model: "gpt-5.6-terra", effort: "low" },
  sonnet: { model: "gpt-5.6-sol", effort: "medium" },
  opus: { model: "gpt-5.6", effort: "high" },
};

function promptArgs(env: NodeJS.ProcessEnv, prompt: string, tier: string, json = false, mcpConfig?: string | null): string[] {
  if (env.JARVIS_AGENT_PROVIDER !== "codex") {
    const args = ["-p", prompt, "--model", tier, "--dangerously-skip-permissions"];
    if (json) args.push("--output-format", "stream-json", "--verbose");
    if (mcpConfig) args.push("--mcp-config", mcpConfig);
    return args;
  }
  const selected = CODEX_MODELS[tier] ?? CODEX_MODELS.sonnet;
  const args = [
    "exec", "--model", selected.model, "--config", `model_reasoning_effort=\"${selected.effort}\"`,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
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
    const p = spawn(bin, promptArgs(env, prompt, tier), { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve(output); }, timeoutMs);
    p.stdout.on("data", (d) => (output += d.toString()));
    p.on("close", () => { clearTimeout(timer); resolve(output); });
    p.on("error", () => { clearTimeout(timer); resolve(""); });
  });
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
  return routeWork(task).model;
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

// Cheapest live price for a product (UK) — self-contained so the price-watch
// cron never has to import the server-only tools module.
async function cheapestPrice(query: string): Promise<{ priceNum: number } | null> {
  // Serper.dev first (way more searches than SerpAPI), SerpAPI fallback.
  const priceOf = (p: any) => {
    const n = parseFloat(String(p ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const serperK = process.env.SERPER_API_KEY || (await vaultService("serper")).SERPER_API_KEY;
  if (serperK) {
    try {
      const r = await fetch("https://google.serper.dev/shopping", {
        method: "POST",
        headers: { "X-API-KEY": serperK, "content-type": "application/json" },
        body: JSON.stringify({ q: query, gl: "gb", hl: "en" }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const j: any = await r.json();
        const prices = (j?.shopping ?? []).map((x: any) => priceOf(x.price)).filter((n: number) => n > 0);
        if (prices.length) return { priceNum: Math.min(...prices) };
      }
    } catch {
      /* fall through to serpapi */
    }
  }
  const key = process.env.SERPAPI_KEY || (await vaultService("serpapi")).SERPAPI_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({ engine: "google_shopping", q: query, gl: "uk", hl: "en", num: "20", api_key: key });
  try {
    const j: any = await (await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(10000) })).json();
    const rows = (j?.shopping_results ?? []).filter((r: any) => r.extracted_price);
    if (!rows.length) return null;
    rows.sort((a: any, b: any) => Number(a.extracted_price) - Number(b.extracted_price));
    return { priceNum: Number(rows[0].extracted_price) };
  } catch {
    return null;
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
  const out = await plainPrompt(bin, env, prompt, "haiku", 60_000);
  const line = out.trim().replace(/\s+/g, " ").replace(/[*#`_]/g, "");
  return line.length > 4 && line.length < 400 ? line : "";
}

// JARVIS checks its agents: a fast haiku pass over every finished job — did
// the work actually get done, is anything off, or did the agent stop on a
// question JARVIS can answer itself (then it auto-continues the session)?
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
  const out = await plainPrompt(bin, env, prompt, "haiku", 60_000);
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
): Promise<{ text: string; timedOut: boolean; stopped: "paused" | "cancelled" | null }> {
  return new Promise((resolve) => {
    const args = promptArgs(env, prompt, model, true, mcpConfig);
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
      resolve({ text: finalText || (timedOut ? "(agent segment timed out)" : stopped ? `(agent ${stopped})` : "(no output)"), timedOut, stopped });
    };
    const to = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(true);
    }, 900_000); // self-repair/improve jobs may run npm install + tsc + build inside the turn
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
          latest = "session started";
          stage = "understanding";
          percent = Math.max(percent, 8);
          pushLog("▸ Codex session started");
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

export const agentRunner = schedules.task({
  id: "jarvis-agent-runner",
  cron: "* * * * *",
  maxDuration: 3600,
  run: async () => {
    const selected = await convexQuery("ui:getAgentProvider", {});
    const provider: AgentProvider = selected === "claude" ? "claude" : "codex";
    const bin = resolveAgentBin(provider);
    if (!bin) return { processed: 0, error: `no ${provider} binary` };
    const prepared = prepareAgentEnv(provider);
    if (prepared.error) return { processed: 0, error: prepared.error };

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
          modelReason: "Paul uses the highest tier for production root-cause repair",
          agentId: "paul",
          risk: "high",
          priority: 90,
          originThreadId: await chatThread(),
          acceptanceCriteria: [
            "Reproduce or evidence the root cause before editing",
            "Implement the smallest safe repair on an isolated branch",
            "Verify the relevant build or live surface and report evidence",
          ],
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
        await sendPush("⏰ JARVIS reminder", String(r.text).slice(0, 140), "/").catch(() => {});
        await convexMutation("reminders:complete", { id: r._id }).catch(() => {});
      }
    } catch {
      /* reminders must never block jobs either */
    }
    // Price watches: re-price a few due products, ping on a meaningful drop.
    try {
      const watches: any[] = (await convexQuery("watches:due", {})) ?? [];
      for (const w of watches) {
        const now = await cheapestPrice(w.query).catch(() => null);
        if (!now) {
          await convexMutation("watches:touch", { id: w._id }).catch(() => {});
          continue;
        }
        const prev = Number(w.lastGbp) || 0;
        const target = Number(w.targetGbp) || 0;
        const hitTarget = target > 0 && now.priceNum <= target;
        const bigDrop = prev > 0 && now.priceNum <= prev * 0.93; // >=7% cheaper
        if (hitTarget || bigDrop) {
          const line = `💸 Price drop, sir — "${w.query}" is now £${now.priceNum}${prev ? ` (was £${prev})` : ""}${target ? `, under your £${target}` : ""}.`;
          await convexMutation("chatQueue:postAssistant", { threadId: await chatThread(), text: line }).catch(() => {});
          await sendPush("💸 Price drop", `${w.query} → £${now.priceNum}`, "/").catch(() => {});
        }
        await convexMutation("watches:record", { id: w._id, lastGbp: now.priceNum }).catch(() => {});
      }
    } catch {
      /* watches never block jobs */
    }
    const env = scopedAgentEnv(prepared.env);
    mkdirSync("/tmp/work", { recursive: true });
    const token = process.env.GITHUB_TOKEN ?? "";

    // Standing briefing every agent reads (global CLAUDE.md in the runner HOME):
    // Daniel's infra map + vault access + repo/deploy conventions = real project access.
    const briefingPath = provider === "claude" ? "/tmp/claude-home/.claude/CLAUDE.md" : "/tmp/codex-home/AGENTS.md";
    writeFileSync(
      briefingPath,
      `# You are a scoped JARVIS permanent-team agent working for Daniel.\n\n${INFRA_MAP}\n\n` +
        `## Capability boundary\n` +
        `You run inside an isolated worktree with no general secrets-vault access. Use only the repository and explicitly attached MCP capabilities. Never seek credentials, publish, message people, spend money, or perform destructive/production actions. If one is required, stop with the exact approval needed.\n\n` +
        `## Conventions\n- The runner supplies the repository when one is in scope; do not clone or push another repository.\n` +
        `- Web research: use your WebSearch/WebFetch tools directly.\n` +
        `- Never invent results. If something is inaccessible, say so plainly in your final answer.\n` +
        `- Final answer style: plain text, the key outcome first, under 300 words.\n`,
    );

    let processed = 0;
    const started = Date.now();

    // One permanent agent's lifecycle: clone an isolated branch, execute one
    // bounded segment, checkpoint or verify, then report to the originating
    // conversation. Mission jobs remain quiet until the reviewed synthesis.
    const processJob = async (job: any): Promise<void> => {
      const originThread = typeof job.originThreadId === "string" && job.originThreadId ? job.originThreadId : "main";
      try {
        let cwd = `/tmp/work/scratch-${String(job.jobId).slice(-6)}`;
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
          const dir = `/tmp/work/${repo.replace(/[^a-zA-Z0-9]/g, "_")}_${String(job.jobId).slice(-6)}`;
          rmSync(dir, { recursive: true, force: true });
          const url = `https://x-access-token:${token}@github.com/${repo}.git`;
          if (job.branch) {
            await sh("git", ["clone", "--depth", "1", "--single-branch", "--branch", String(job.branch), url, dir], env);
          }
          if (!existsSync(join(dir, ".git"))) {
            rmSync(dir, { recursive: true, force: true });
            await sh("git", ["clone", "--depth", "1", url, dir], env);
          }
          if (existsSync(join(dir, ".git"))) {
            cwd = dir;
            repoDir = dir;
            await sh("git", ["-C", dir, "config", "user.email", "jarvis@daniels-project-space.dev"], env);
            await sh("git", ["-C", dir, "config", "user.name", `${profile.name} via JARVIS`], env);
            baseSha = (await sh("git", ["-C", dir, "rev-parse", "HEAD"], env)).out.trim();
            if (branch) await sh("git", ["-C", dir, "checkout", "-B", branch], env);
            if (branch) await convexMutation("jobs:setDelivery", { jobId: job.jobId, branch }).catch(() => {});
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
        const criteria = Array.isArray(job.acceptanceCriteria) && job.acceptanceCriteria.length
          ? job.acceptanceCriteria.map(String)
          : ["Deliver the requested outcome with concrete evidence"];
        const checkpoint = job.checkpoint
          ? `\n\nCONTINUATION CHECKPOINT (attempt ${job.attempt ?? 1}; preserve completed work, do not start over):\n${String(job.checkpoint).slice(0, 6000)}`
          : "";
        const prompt =
          `You are ${profile.name}, JARVIS's permanent ${profile.role}.\n${profile.instructions}\n\n${context}\n\n` +
          `TASK:\n${job.task}\n\nDEFINITION OF DONE:\n${criteria.map((item: string) => `- ${item}`).join("\n")}` +
          `${checkpoint}\n\nBefore finishing, verify the definition of done and explicitly report the evidence. If a consequential action or personal decision is required, stop and ask one precise question.`;
        const model = typeof job.model === "string" && job.model ? job.model : pickAgentModel(job.task);
        const mcpConfig = Array.isArray(job.mcp) && job.mcp.length ? await buildMcpConfig(job.mcp) : null;
        const run = await runAgent(
          bin,
          cwd,
          env,
          prompt,
          model,
          (line, log, stage, percent) => {
            void convexMutation("jobs:updateProgress", { jobId: job.jobId, progress: line, log, stage, percent });
          },
          mcpConfig,
          async () => String((await convexQuery("jobs:executionState", { jobId: job.jobId })) ?? "running"),
        );
        const result = run.text;

        let pushNote = "";
        let pushFailed = false;
        let changed = false;
        if (repoDir && token && branch && !job.readonly) {
          const pushUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
          await sh("git", ["-C", repoDir, "add", "-A"], env);
          await sh(
            "git",
            ["-C", repoDir, "commit", "-m", `chore: ${profile.name.toLowerCase()} — ${job.task.slice(0, 60).replace(/"/g, "'")}`],
            env,
          );
          const local = (await sh("git", ["-C", repoDir, "rev-parse", "HEAD"], env)).out.trim();
          const remote = (await sh("git", ["-C", repoDir, "ls-remote", pushUrl, `refs/heads/${branch}`], env)).out.split(/\s/)[0]?.trim();
          const needsPush = Boolean(local && local !== (remote || baseSha));
          if (!needsPush) {
            pushNote = remote ? `existing checkpoint branch ${branch} retained` : "no repository changes were needed";
          } else {
            let push = await sh("git", ["-C", repoDir, "push", pushUrl, `HEAD:refs/heads/${branch}`], env);
            if (/shallow update not allowed/i.test(push.out)) {
              await sh("git", ["-C", repoDir, "fetch", "--unshallow"], env);
              push = await sh("git", ["-C", repoDir, "push", pushUrl, `HEAD:refs/heads/${branch}`], env);
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

        const checkpointText =
          `Attempt ${job.attempt ?? 1} ${run.timedOut ? "reached its segment boundary" : run.stopped ? `was ${run.stopped}` : "ended before verification"}. ` +
          `${pushNote ? `${pushNote}. ` : ""}Continue the original task from this evidence:\n${result.slice(0, 5000)}`;
        if (run.stopped) {
          await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            checkpoint: checkpointText,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
            nextStatus: run.stopped,
          });
          return;
        }
        const failedRun = /^error:/i.test(result) || result === "(no output)";
        if ((run.timedOut || failedRun) && !cloneFailed && !pushFailed) {
          const continuation = await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            checkpoint: checkpointText,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
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
          await convexMutation("jobs:finalize", { jobId: job.jobId, status: "error", result: failure.slice(0, 4000) });
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

        await convexMutation("jobs:updateProgress", {
          jobId: job.jobId,
          progress: "JARVIS is reviewing the evidence",
          stage: "supervisor review",
          percent: 92,
        }).catch(() => {});
        const needsDaniel = /\b(need (your|daniel)|which (one|option)|please (confirm|choose|decide)|waiting on (you|daniel)|\?\s*$)/i.test(
          result.slice(-500),
        );
        const verify = await verifyWork(bin, env, job.task, result).catch(() => null);
        if (verify?.verdict === "needs_input" && verify.answer) {
          await convexMutation("jobs:checkpointAndRequeue", {
            jobId: job.jobId,
            checkpoint:
              `Previous work:\n${result.slice(0, 4200)}\n\nThe specialist stopped on: ${verify.note}\nJARVIS's supervisor decision: ${verify.answer}\nContinue and finish; do not ask Daniel this ordinary implementation question again.`,
            result: result.slice(0, 4000),
            branch: branch ?? undefined,
          });
          if (!job.missionId)
            await convexMutation("chatQueue:postAssistant", {
              threadId: originThread,
              text: `${profile.name} hit an implementation choice; I made the call and sent the checkpoint back to finish.`,
            }).catch(() => {});
          return;
        }
        if (verify?.verdict === "needs_input" || needsDaniel) {
          const question = verify?.note || result.slice(-500).trim() || "A personal or consequential decision is required.";
          await convexMutation("jobs:requestInput", {
            jobId: job.jobId,
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
          pullRequestUrl = await openDraftPullRequest(
            repo,
            branch,
            `${profile.name}: ${(job.label ?? job.task).slice(0, 82)}`,
            `## JARVIS work order\n${job.task}\n\n## Acceptance criteria\n${criteria.map((item: string) => `- ${item}`).join("\n")}\n\n## Agent evidence\n${result}`,
            token,
          );
          await convexMutation("jobs:setDelivery", {
            jobId: job.jobId,
            branch,
            pullRequestUrl: pullRequestUrl ?? undefined,
          }).catch(() => {});
          pushNote = pullRequestUrl ? `draft PR ready: ${pullRequestUrl}` : `${pushNote}; draft PR creation needs review`;
        }
        const deliveryResult = `${result}${pushNote ? `\n\nDelivery: ${pushNote}` : ""}`;
        await convexMutation("jobs:finalize", {
          jobId: job.jobId,
          status: "done",
          result: deliveryResult.slice(0, 4000),
          pullRequestUrl: pullRequestUrl ?? undefined,
        });
        if (job.incidentId)
          await convexMutation("incidents:setStatus", { id: job.incidentId, status: "resolved" }).catch(() => {});

        if (job.missionId) {
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
          (await weaveLine(bin, env, job.task, deliveryResult)) ||
          `${profile.name} finished and JARVIS verified the evidence${pullRequestUrl ? "; a draft PR is ready for review" : ""}.`;
        if (verify?.verdict === "concerns" && verify.note) spoken += ` One concern from review: ${verify.note}`;
        else if (verify?.verdict === "pass") spoken += " Supervisor check passed.";
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
          checkpoint: `Runner exception on attempt ${job.attempt ?? 1}: ${message.slice(0, 1200)}. Retry from the original task with a different approach.`,
          result: message.slice(0, 4000),
          branch: job.branch ?? undefined,
        }).catch(() => null);
        if (job.incidentId)
          await convexMutation("incidents:setStatus", { id: job.incidentId, status: "open" }).catch(() => {});
        if (!job.missionId && !recovered?.requeued)
          await convexMutation("chatQueue:postAssistant", {
            threadId: originThread,
            text: `⚠️ ${job.agentId ?? "Agent"} exhausted its recovery budget: ${message.slice(0, 240)}`,
          }).catch(() => {});
      }
    };

    // When the LAST fleet agent lands, merge everything into one report.
    // missions:checkComplete is atomic — exactly one runner wins the synthesis.
    const maybeSynthesizeMission = async (missionId: string): Promise<void> => {
      const synth: any = await convexMutation("missions:checkComplete", { id: missionId }).catch(() => null);
      if (!synth) return;
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
        "sonnet",
      );
      const report = merged.text && !/^error:/.test(merged.text) && merged.text !== "(no output)"
        ? merged.text
        : `## Mission\n${synth.goal}\n\n${body.slice(0, 6000)}`;
      await convexMutation("missions:finish", { id: missionId, summary: report.slice(0, 4000), failed: failedAll });
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
