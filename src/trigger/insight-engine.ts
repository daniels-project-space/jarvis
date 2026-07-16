import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { sendPush } from "./push-send";

// Proactive attention triage: a few times a day Sentry ranks evidence by impact,
// urgency and confidence. Results live in the command deck; only genuinely
// urgent high-confidence decisions interrupt Daniel.

const nodeRequire = createRequire(import.meta.url);
const CONVEX =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";

type AgentProvider = "codex" | "claude";
function resolveAgentBin(provider: AgentProvider): string | null {
  try {
    const command = provider === "codex" ? "codex" : "claude";
    const pkgJson = nodeRequire.resolve(`${provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code"}/package.json`);
    const pkgDir = dirname(pkgJson);
    const nm = dirname(dirname(pkgDir));
    const cands = [join(nm, ".bin", command)];
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[command];
    if (rel) cands.push(join(pkgDir, rel));
    return cands.find((c) => existsSync(c)) ?? null;
  } catch {
    return null;
  }
}
async function q(path: string, args: unknown) {
  try {
    return (
      await (
        await fetch(`${CONVEX}/api/query`, {
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
async function m(path: string, args: unknown) {
  await fetch(`${CONVEX}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  }).catch(() => {});
}

function ask(provider: AgentProvider, bin: string, env: NodeJS.ProcessEnv, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const args = provider === "claude"
      ? ["-p", prompt, "--model", "sonnet", "--dangerously-skip-permissions"]
      : ["exec", "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="medium"', "--dangerously-bypass-approvals-and-sandbox", prompt];
    const p = spawn(bin, args, {
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
    }, 120_000);
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
}


async function chatThread(): Promise<string> {
  try {
    const r = await fetch(`${CONVEX}/api/query`, {
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

export const insightEngine = schedules.task({
  id: "jarvis-insight-engine",
  cron: "0 8,14,20 * * *", // 3x/day
  maxDuration: 200,
  run: async () => {
    const provider: AgentProvider = (await q("ui:getAgentProvider", {})) === "claude" ? "claude" : "codex";
    const bin = resolveAgentBin(provider);
    if (!bin) return { error: `no ${provider} bin` };
    let env: NodeJS.ProcessEnv;
    if (provider === "claude") {
      mkdirSync("/tmp/claude-home", { recursive: true });
      env = { ...process.env, HOME: "/tmp/claude-home", ANTHROPIC_API_KEY: "" };
    } else {
      const home = "/tmp/codex-home";
      mkdirSync(home, { recursive: true });
      const encoded = process.env.CODEX_AUTH_JSON_B64, raw = process.env.CODEX_AUTH_JSON;
      if (encoded || raw) try {
        const json = encoded ? Buffer.from(encoded, "base64").toString("utf8") : raw!;
        JSON.parse(json);
        writeFileSync(join(home, "auth.json"), json, { mode: 0o600 });
        chmodSync(join(home, "auth.json"), 0o600);
      } catch { return { error: "invalid Codex subscription auth" }; }
      if (!process.env.CODEX_ACCESS_TOKEN && !encoded && !raw) return { error: "Codex subscription auth is not configured" };
      env = { ...process.env, HOME: home, CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "" };
    }
    env = Object.fromEntries(
      ["PATH", "HOME", "CODEX_HOME", "LANG", "LC_ALL", "NODE_PATH", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN"]
        .filter((key) => env[key] !== undefined)
        .map((key) => [key, env[key]]),
    ) as NodeJS.ProcessEnv;
    env.ANTHROPIC_API_KEY = "";
    env.OPENAI_API_KEY = "";
    env.CODEX_API_KEY = "";

    const snapshot: any = (await q("brainContext:snapshot", {})) ?? {};
    const biz: any[] = Array.isArray(snapshot.business) ? snapshot.business : [];
    const stack: any[] = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const jobs: any[] = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
    const dataBlob =
      "BUSINESS:\n" +
      biz.map((b) => `- ${b.domain}: ${b.headline}${b.detail ? " " + b.detail : ""}`).join("\n") +
      "\n\nCLOUD STACK:\n" +
      stack.map((s) => `- ${s.slug}: ${s.status}`).join(", ") +
      "\n\nRECENT AGENT JOBS:\n" +
      jobs.map((j) => `- [${j.status}] ${j.task}`).join("\n");

    const prompt =
      "You are Sentry, JARVIS's attention triage lead. From only the evidence below, return at most 5 items that " +
      "materially deserve action. Do not summarize healthy systems and do not manufacture urgency. Separate what " +
      "Daniel personally must decide from reversible work JARVIS can propose or safely repair. Impact and urgency are " +
      "0-100; confidence is 0-1. fingerprint must be stable and terse (project:issue-kind) so repeated runs deduplicate. " +
      'Output STRICT JSON only: [{"fingerprint":"...","project":"...","title":"...","detail":"...",' +
      '"evidence":["..."],"severity":"info|opportunity|warning|critical","impact":0,"urgency":0,"confidence":0,' +
      '"actionClass":"inform|ask|propose|safe-auto-fix"}]. Empty [] if nothing genuinely noteworthy.\n\n' +
      dataBlob;

    const out = await ask(provider, bin, env, prompt);
    const match = out.match(/\[[\s\S]*\]/);
    if (!match) return { insights: 0 };
    let items: any[] = [];
    try {
      items = JSON.parse(match[0]);
    } catch {
      return { insights: 0 };
    }
    const kept = (Array.isArray(items) ? items : [])
      .filter((i) => i?.fingerprint && i?.title && i?.detail)
      .filter((i) => Number(i.confidence) >= 0.55)
      .slice(0, 5);
    for (const it of kept) {
      await m("attention:upsert", {
        fingerprint: String(it.fingerprint).slice(0, 120),
        project: it.project ? String(it.project).slice(0, 80) : undefined,
        title: String(it.title).slice(0, 140),
        detail: String(it.detail).slice(0, 2000),
        evidence: Array.isArray(it.evidence) ? it.evidence.map(String).slice(0, 8) : [],
        severity: ["info", "opportunity", "warning", "critical"].includes(it.severity) ? it.severity : "info",
        impact: Math.max(0, Math.min(100, Number(it.impact) || 0)),
        urgency: Math.max(0, Math.min(100, Number(it.urgency) || 0)),
        confidence: Math.max(0, Math.min(1, Number(it.confidence) || 0)),
        actionClass: ["inform", "ask", "propose", "safe-auto-fix"].includes(it.actionClass) ? it.actionClass : "inform",
      });
    }
    // The command deck is the default surface. Interrupt only for a critical,
    // high-confidence item that is genuinely Daniel's decision.
    const top = kept
      .filter((i) => i.severity === "critical" && i.actionClass === "ask" && Number(i.confidence) >= 0.85)
      .sort((a, b) => Number(b.impact) * Number(b.urgency) - Number(a.impact) * Number(a.urgency))[0];
    if (top) {
      await m("chatQueue:postAssistant", { threadId: await chatThread(), text: `This genuinely needs you: ${top.title} — ${top.detail}` });
      await sendPush("JARVIS needs you", String(top.title).slice(0, 140), "/");
    }
    return { insights: kept.length };
  },
});
