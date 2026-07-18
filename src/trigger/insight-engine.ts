import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { sendPush } from "./push-send";
import { codexExecPrefix } from "./model-policy";
import { wakeAgentHarness } from "../lib/agent-harness-wake";
import {
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  type AgentProvider,
} from "./subscription-runtime";

// Proactive attention triage: hourly Sentry ranks evidence by impact,
// urgency and confidence. Results live in the command deck; only genuinely
// urgent high-confidence decisions interrupt Daniel.

const CONVEX =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
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
async function m(path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const protectedArgs = { ...((args ?? {}) as Record<string, unknown>), workerToken };
  const response = await fetch(`${CONVEX}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: protectedArgs, format: "json" }),
  }).catch(() => null);
  if (!response) return null;
  const payload = await response.json().catch(() => null);
  return payload?.value ?? null;
}

function ask(provider: AgentProvider, bin: string, env: NodeJS.ProcessEnv, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (provider !== "codex") return resolve("");
    const args = [...codexExecPrefix("terra"), prompt];
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
    const t = await q("ui:getActiveThread", {});
    return typeof t === "string" && t ? t : "main";
  } catch {
    return "main";
  }
}

export const insightEngine = schedules.task({
  id: "jarvis-insight-engine",
  cron: "7 * * * *",
  maxDuration: 200,
  run: async () => {
    const provider: AgentProvider = "codex";
    const bin = resolveSubscriptionAgentBin(provider);
    if (!bin) return { error: `no ${provider} bin` };
    const prepared = prepareSubscriptionEnv(provider);
    if (prepared.error) return { error: prepared.error };
    const env = prepared.env;

    const snapshot: any = (await q("brainContext:snapshot", {})) ?? {};
    const biz: any[] = Array.isArray(snapshot.business) ? snapshot.business : [];
    const stack: any[] = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const jobs: any[] = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
    const goals: any[] = Array.isArray(snapshot.goals) ? snapshot.goals : [];
    const priorAttention: any[] = Array.isArray(snapshot.attention) ? snapshot.attention : [];
    const knownProjects = new Set(stack.map((project) => String(project.slug ?? "")).filter(Boolean));
    const dataBlob =
      "BUSINESS:\n" +
      biz.map((b) => `- ${b.domain}: ${b.headline}${b.detail ? " " + b.detail : ""}`).join("\n") +
      "\n\nCLOUD STACK:\n" +
      stack.map((s) => `- ${s.slug}: ${s.status}; purpose=${s.data?.purpose ?? "unknown"}; objective=${s.data?.objectives?.[0] ?? "unknown"}`).join("\n") +
      "\n\nDURABLE GOALS:\n" +
      goals.map((goal) => `- ${goal.project}: ${goal.title} [${goal.status}, ${goal.progress}%] next=${goal.nextAction ?? "unset"}`).join("\n") +
      "\n\nRECENT AGENT JOBS:\n" +
      jobs.map((j) => `- [${j.status}] ${j.task}`).join("\n");

    const prompt =
      "You are Sentry, JARVIS's attention triage lead. From only the evidence below, return at most 5 items that " +
      "materially deserve action. Do not summarize healthy systems and do not manufacture urgency. Separate what " +
      "Daniel personally must decide from reversible work JARVIS can safely repair. A concrete code or runtime defect " +
      "in a known project that can be reproduced, fixed on an isolated branch, tested, and left unmerged is safe-auto-fix; " +
      "deployment, merging, spending, publishing, financial execution, destructive data work, and external messaging remain gated. Impact and urgency are " +
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
      const attentionArgs = {
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
      };
      await m("attention:upsert", attentionArgs);
      const alreadyOwned = priorAttention.find((item) => item.fingerprint === attentionArgs.fingerprint && (item.status === "working" || item.jobId));
      if (
        attentionArgs.actionClass === "safe-auto-fix" &&
        Number(attentionArgs.confidence) >= 0.78 &&
        Number(attentionArgs.impact) >= 40 &&
        attentionArgs.project &&
        knownProjects.has(attentionArgs.project) &&
        !alreadyOwned
      ) {
        const jobId = await m("jobs:enqueue", {
          repo: `daniels-project-space/${attentionArgs.project}`,
          task:
            `Safely investigate and repair this evidence-backed issue in ${attentionArgs.project}: ${attentionArgs.title}. ` +
            `${attentionArgs.detail}\nEvidence: ${attentionArgs.evidence.join("; ")}. ` +
            `Work on an isolated branch, preserve project safety gates, verify the exact relevant surface, and stop for Daniel if the required action becomes consequential.`,
          readonly: false,
          agentId: "paul",
          risk: "low",
          priority: Math.round(Number(attentionArgs.impact)),
          originThreadId: await chatThread(),
          visibility: "system",
          acceptanceCriteria: [
            "Reproduce or prove the issue before editing",
            "Implement a root-cause fix without weakening safety gates",
            "Return build/test and provider evidence, or an explicit blocker",
          ],
          modelReason: "Evidence-backed reversible maintenance selected by Sentry; work policy remains the final approval backstop",
        });
        if (jobId) {
          await m("attention:upsert", { ...attentionArgs, status: "working", jobId: String(jobId) });
          await wakeAgentHarness(`insight:${attentionArgs.project}:${String(jobId)}`).catch(() => false);
        }
      }
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
