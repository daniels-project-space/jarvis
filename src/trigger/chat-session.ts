import { schedules, task } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { CAPABILITIES, INFRA_MAP, PERSONA, REMEMBER } from "../lib/persona";
import { buildContext } from "../lib/context";
import { codexExecPrefix, codexModelFor, pickConversationTier } from "./model-policy";
import {
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  type AgentProvider,
} from "./subscription-runtime";

function cliArgs(provider: AgentProvider, prompt: string, tier: string, json = false): string[] {
  if (provider === "claude") {
    const args = ["-p", prompt, "--model", tier, "--dangerously-skip-permissions"];
    if (json) args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
    return args;
  }
  const args = codexExecPrefix(tier);
  if (json) args.push("--json");
  args.push(prompt);
  return args;
}

// Subscription brain: each queued chat turn runs the selected Codex or Claude
// CLI headlessly, with metered API keys blanked and only the chosen subscription
// credential exposed. This is conversational—repository work is delegated to
// the durable agent runner. Bounded memory and project context come from Convex.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const RUN_BUDGET_MS = 50_000;
const POLL_MS = 2000;
const IDLE_EXITS = 3;
const TURN_TIMEOUT_MS = 8 * 60_000;

async function convexCall(kind: "query" | "mutation", path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      args: { ...((args ?? {}) as Record<string, unknown>), workerToken },
      format: "json",
    }),
  });
  const body = await response.json().catch(() => null) as {
    status?: string;
    value?: unknown;
    errorMessage?: string;
  } | null;
  if (!response.ok || !body || body.status === "error") {
    throw new Error(
      `Convex ${kind} ${path} failed: ${String(body?.errorMessage ?? response.status).slice(0, 300)}`,
    );
  }
  return body.value;
}

async function convexMutation(path: string, args: unknown) {
  return convexCall("mutation", path, args);
}
async function convexQuery(path: string, args: unknown) {
  return convexCall("query", path, args);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Turn = { finalText: string; sessionId: string | null; code: number | null; stderr: string };

// Intelligent model routing: cheap Haiku for chat/lookups, Opus for real work.
function runTurn(
  provider: AgentProvider,
  bin: string,
  env: NodeJS.ProcessEnv,
  assistantId: string,
  userText: string,
  history: { role: string; text: string }[],
  contextBlock: string,
  model: string,
): Promise<Turn> {
  const toolEndpoint = "https://jarvis-orcin-six.vercel.app/api/agent-tool";
  const preamble =
    PERSONA +
    `\n\n${CAPABILITIES}\n\n${INFRA_MAP}\n\nWhat you know right now:\n${contextBlock}\n\nCurrent date: ${new Date().toDateString()}.\n\n${REMEMBER}\n\n` +
    `FUNCTIONAL TOOLS: you can really act and render visuals through Jarvis's private tool bridge. Fetch only the belt needed with ` +
    `curl -s -H 'Authorization: Bearer '"$JARVIS_DISPATCH_TOKEN" '${toolEndpoint}?belt=core' ` +
    `(belts: core, work, creative, travel, business). Then call one with ` +
    `curl -s -X POST '${toolEndpoint}' -H 'Authorization: Bearer '"$JARVIS_DISPATCH_TOKEN" -H 'content-type: application/json' ` +
    `--data '{"name":"<tool>","args":{...}}'. Read the returned result and continue. ` +
    `Use tools whenever Daniel asks you to show, make, change, search, remember, schedule, monitor, chart, plan travel, or delegate—never merely claim it happened. ` +
    `Never print, reveal, transform, or send the capability token anywhere except this exact Jarvis endpoint. You cannot approve consequential work; Daniel does that in the command deck. ` +
    `Answer directly and naturally. Never narrate context, memory, shell commands, or tool plumbing.`;
  const convo = history.length
    ? "Recent conversation:\n" +
      history.map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`).join("\n") +
      "\n\n"
    : "";
  const prompt = `${convo}User: ${userText}`;
  const fullPrompt = provider === "codex" ? `${preamble}\n\n${prompt}` : prompt;
  const args = cliArgs(provider, fullPrompt, model, true);
  if (provider === "claude") args.splice(2, 0, "--append-system-prompt", preamble);
  return new Promise((resolve) => {
    const p = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "",
      finalText = "",
      pending = "",
      stderr = "";
    let sessionId: string | null = null;
    let timedOut = false;
    const flush = async () => {
      if (!pending) return;
      const c = pending;
      pending = "";
      await convexMutation("chatQueue:appendChunk", { messageId: assistantId, chunk: c }).catch(() => {});
    };
    const timer = setInterval(() => void flush(), 600);
    const timeout = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, TURN_TIMEOUT_MS);
    p.stderr.on("data", (d) => (stderr += d.toString()));
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
        if (ev.session_id && !sessionId) sessionId = ev.session_id;
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") sessionId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
          finalText = ev.item.text;
          pending += ev.item.text;
        }
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const t = ev.event.delta?.text;
          if (typeof t === "string") pending += t;
        }
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });
    p.on("close", async (code) => {
      clearInterval(timer);
      clearTimeout(timeout);
      await flush();
      resolve({
        finalText,
        sessionId,
        code: timedOut ? -2 : code,
        stderr: timedOut ? "Codex conversation turn exceeded 8 minutes" : stderr.slice(-400),
      });
    });
    p.on("error", async (e) => {
      clearInterval(timer);
      clearTimeout(timeout);
      await flush();
      resolve({ finalText, sessionId, code: -1, stderr: (stderr + "\n" + e.message).slice(-400) });
    });
  });
}

// Stage 0 capture: a cheap Haiku pass extracts durable facts from the turn and
// persists them (decoupled from the conversation = far more reliable than
// in-turn tool calls; the mem0 / Letta sleep-time pattern).
async function extractAndSave(
  provider: AgentProvider,
  bin: string,
  env: NodeJS.ProcessEnv,
  userText: string,
  assistantText: string,
): Promise<number> {
  const prompt =
    "From the exchange below, extract ONLY durable facts, preferences, decisions, or tasks worth " +
    "remembering long-term about Daniel or his projects. Output STRICT JSON: an array of " +
    '{"kind","title","body","tags"} where kind is one of fact|preference|decision|task|project. ' +
    "Output [] if nothing is worth remembering. No prose, JSON only.\n\n" +
    `User: ${userText}\nAssistant: ${assistantText}`;
  const out = await new Promise<string>((resolve) => {
    const p = spawn(bin, cliArgs(provider, prompt, "haiku"), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    const timeout = setTimeout(() => p.kill("SIGKILL"), 90_000);
    p.stdout.on("data", (d) => (o += d.toString()));
    p.on("close", () => {
      clearTimeout(timeout);
      resolve(o);
    });
    p.on("error", () => {
      clearTimeout(timeout);
      resolve("");
    });
  });
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return 0;
  let items: any[] = [];
  try {
    items = JSON.parse(m[0]);
  } catch {
    return 0;
  }
  let n = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 8)) {
    if (!it?.title || !it?.body) continue;
    await convexMutation("memory:write", {
      kind: String(it.kind || "fact"),
      title: String(it.title).slice(0, 120),
      body: String(it.body).slice(0, 1200),
      tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 6) : [],
    }).catch(() => {});
    n++;
  }
  return n;
}

async function processChatQueue() {
  const selected = await convexQuery("ui:getAgentProvider", {});
  const provider: AgentProvider = selected === "claude" ? "claude" : "codex";
  const prepared = prepareSubscriptionEnv(provider, { includeDispatch: true });
  if (prepared.error) return { processed: 0, error: prepared.error };
  const env = prepared.env;
  const bin = resolveSubscriptionAgentBin(provider);
  if (!bin) return { processed: 0, error: `${provider} binary not found` };

  const started = Date.now();
  let processed = 0,
    idle = 0;
  while (Date.now() - started < RUN_BUDGET_MS) {
    const claim: any = await convexMutation("chatQueue:claimNext", {});
    if (!claim) {
      idle += 1;
      if (processed === 0 && idle >= IDLE_EXITS) break;
      await sleep(POLL_MS);
      continue;
    }
    idle = 0;
    try {
      const context = await buildContext(claim.userText);
      const model = pickConversationTier(claim.userText);
      const turn = await runTurn(
        provider,
        bin,
        env,
        claim.assistantId,
        claim.userText,
        claim.history,
        context.block,
        model,
      );
      const finalText =
        turn.finalText.trim() ||
        (turn.code === 0
          ? "(the agent finished without producing text)"
          : `⚠️ run failed (exit ${turn.code}). ${turn.stderr || ""}`.trim());
      await convexMutation("chatQueue:finalize", {
        messageId: claim.assistantId,
        threadId: claim.threadId,
        status: turn.finalText.trim() ? "done" : "error",
        finalText,
        claudeSessionId: turn.sessionId ?? undefined,
        model: provider === "codex" ? `codex · ${codexModelFor(model).model}` : `${provider} · ${model}`,
      });
      // Stage 0: capture durable memory from this turn (after reply is delivered).
      if (turn.finalText.trim())
        await extractAndSave(provider, bin, env, claim.userText, turn.finalText).catch(() => {});
      processed += 1;
    } catch (e: any) {
      await convexMutation("chatQueue:finalize", {
        messageId: claim.assistantId,
        threadId: claim.threadId,
        status: "error",
        finalText: `⚠️ ${e?.message ?? String(e)}`,
      }).catch(() => {});
    }
  }
  return { processed };
}

// The app triggers this task immediately after committing a user turn. The
// single shared queue preserves conversational ordering while avoiding the
// old 0-60 second cron wait.
export const chatTurn = task({
  id: "jarvis-chat-turn",
  queue: { name: "jarvis-conversation", concurrencyLimit: 1 },
  maxDuration: 3300,
  run: async () => processChatQueue(),
});

// Recovery lane only: if an immediate trigger is lost between Vercel and
// Trigger, the next schedule drains the durable Convex queue.
export const chatDispatcher = schedules.task({
  id: "jarvis-chat-dispatcher",
  cron: "*/1 * * * *",
  queue: { name: "jarvis-conversation", concurrencyLimit: 1 },
  maxDuration: 3300,
  run: async () => processChatQueue(),
});
