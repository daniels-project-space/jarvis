import { schedules } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

// The `claude` binary isn't on PATH in the Trigger image — resolve it from the
// installed @anthropic-ai/claude-code package (mirrors remote-work-hub).
function resolveClaudeBin(): string | null {
  try {
    const pkgJson = nodeRequire.resolve("@anthropic-ai/claude-code/package.json");
    const pkgDir = dirname(pkgJson);
    const nodeModules = dirname(dirname(pkgDir));
    const candidates = [join(nodeModules, ".bin", "claude")];
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
        bin?: string | Record<string, string>;
      };
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

// Subscription brain: each chat turn runs the real `claude` CLI HEADLESS on
// Daniel's Max subscription (CLAUDE_CODE_OAUTH_TOKEN from the vault, ANTHROPIC_API_KEY
// blanked). Mirrors remote-work-hub's proven pattern; no repo clone/push — this is
// a general assistant, not a coding agent. Memory is injected from Convex.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
const RUN_BUDGET_MS = 50_000;
const POLL_MS = 2000;
const IDLE_EXITS = 3;

async function convexMutation(path: string, args: unknown) {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()).value;
}
async function convexQuery(path: string, args: unknown) {
  const r = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  return (await r.json()).value;
}
// project-hub lives on a different Convex deployment (Daniel's dashboard: to-dos,
// calendar, net worth, widgets, settings). Read-only awareness for the brain.
const HUB_URL = "https://fantastic-roadrunner-485.convex.cloud";
async function hubQuery(path: string) {
  try {
    const r = await fetch(`${HUB_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {}, format: "json" }),
    });
    return (await r.json()).value;
  } catch {
    return null;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Turn = { finalText: string; sessionId: string | null; code: number | null; stderr: string };

// Intelligent model routing: cheap Haiku for chat/lookups, Opus for real work.
function pickModel(text: string): string {
  const t = text.toLowerCase().trim();
  if (
    /\b(fix|debug|refactor|implement|build|architect|design|migrate|optimi[sz]e|investigate|analy[sz]e|root cause|plan|code|deploy|dispatch|run an agent)\b/.test(
      t,
    ) ||
    /\brepo\b|codebase/.test(t)
  )
    return "opus";
  if (
    t.length <= 60 &&
    /^(hi|hey|hello|yo|thanks|thank you|ok|okay|sup|morning|evening|good (morning|evening|day)|what'?s up|how are you)\b/.test(t)
  )
    return "haiku";
  if (t.length <= 50) return "haiku";
  return "sonnet";
}

function runTurn(
  bin: string,
  env: NodeJS.ProcessEnv,
  assistantId: string,
  userText: string,
  history: { role: string; text: string }[],
  memoryContext: string,
  stackContext: string,
  businessContext: string,
  model: string,
): Promise<Turn> {
  const preamble =
    "You are JARVIS — Daniel's personal AI assistant, confidant, and friend. Think a warm, witty, razor-sharp " +
    "British companion (a touch of dry humour), NOT a corporate chatbot. You genuinely know him and his work.\n" +
    "CRITICAL — HOW YOU TALK: every reply is READ ALOUD by a voice AND shown as a chat bubble, so write the way a " +
    "real person SPEAKS. Absolutely NO markdown of any kind: no asterisks, no **bold**, no ## headings, no bullet " +
    "points or dashes as lists, no backticks or code fences, no emoji, no smileys, no stage directions, no URLs read " +
    "out. If you must list things, say them as a natural spoken sentence ('you've got three rentals out and one " +
    "coming back Friday'). Write numbers and money the way you'd say them aloud. BE BRIEF — answer in ONE short " +
    "sentence, two at the very most. Lead with the answer, cut every non-essential word, no preamble or sign-off. " +
    "Only give a longer breakdown if he explicitly asks for detail or 'the full picture'. Never say 'as an AI', never narrate your process. Never fabricate. " +
    (memoryContext ? `Relevant long-term memory:\n${memoryContext}\n` : "") +
    (stackContext ? `Current cloud-stack (Vercel deploy states): ${stackContext}\n` : "") +
    (businessContext
      ? `What you know about Daniel right now — his businesses (rentals, items, music), his to-do list, his calendar, his net worth and dashboard. When he asks about his tasks, schedule, money, or how things are doing, answer briefly and naturally from these real facts, never recite them like a table:\n${businessContext}\n`
      : "") +
    `To DISPATCH a background agent (ONLY when Daniel asks you to run/build/action/fix something in the ` +
    `background or on a repo), run this bash, then tell him it's dispatched and you'll report back when done: ` +
    `curl -s -X POST '${CONVEX_URL}/api/mutation' -H 'content-type: application/json' ` +
    `-d '{"path":"jobs:enqueue","args":{"task":"<clear, self-contained task>","repo":"<owner/repo or empty string>","model":"<haiku|sonnet|opus>"}}'. ` +
    `Choose model by difficulty: opus for architecture/multi-file/debugging, sonnet for normal edits, haiku for trivial lookups (omit to auto-route).\n` +
    `To SHOW Daniel something on screen (pull up a website, open a document/notes, display an image) when he ` +
    `asks you to show/pull up/open something, run: curl -s -X POST '${CONVEX_URL}/api/mutation' ` +
    `-H 'content-type: application/json' -d '{"path":"ui:setPanel","args":{"type":"url","value":"https://…","title":"<label>"}}' ` +
    `(type can be "url", "markdown" for text/notes, or "image").\n` +
    "Answer the user's question directly, using the memory and cloud-stack facts above when relevant. " +
    "NEVER narrate your process or mention 'context', 'memory', or 'tool calls' — just give the answer itself.";
  const convo = history.length
    ? "Recent conversation:\n" +
      history.map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`).join("\n") +
      "\n\n"
    : "";
  const prompt = `${convo}User: ${userText}`;
  const args = [
    "-p",
    prompt,
    "--append-system-prompt",
    preamble,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];
  return new Promise((resolve) => {
    const p = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "",
      finalText = "",
      pending = "",
      stderr = "";
    let sessionId: string | null = null;
    const flush = async () => {
      if (!pending) return;
      const c = pending;
      pending = "";
      await convexMutation("chatQueue:appendChunk", { messageId: assistantId, chunk: c }).catch(() => {});
    };
    const timer = setInterval(() => void flush(), 600);
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
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
          const t = ev.event.delta?.text;
          if (typeof t === "string") pending += t;
        }
        if (ev.type === "result" && typeof ev.result === "string") finalText = ev.result;
      }
    });
    p.on("close", async (code) => {
      clearInterval(timer);
      await flush();
      resolve({ finalText, sessionId, code, stderr: stderr.slice(-400) });
    });
    p.on("error", async (e) => {
      clearInterval(timer);
      await flush();
      resolve({ finalText, sessionId, code: -1, stderr: (stderr + "\n" + e.message).slice(-400) });
    });
  });
}

// Stage 0 capture: a cheap Haiku pass extracts durable facts from the turn and
// persists them (decoupled from the conversation = far more reliable than
// in-turn tool calls; the mem0 / Letta sleep-time pattern).
async function extractAndSave(
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
    const p = spawn(bin, ["-p", prompt, "--model", "haiku", "--dangerously-skip-permissions"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    p.stdout.on("data", (d) => (o += d.toString()));
    p.on("close", () => resolve(o));
    p.on("error", () => resolve(""));
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

export const chatDispatcher = schedules.task({
  id: "jarvis-chat-dispatcher",
  cron: "*/1 * * * *",
  maxDuration: 3300,
  run: async () => {
    // CLAUDE_CODE_OAUTH_TOKEN is injected by the Trigger project env (Max sub).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: "/tmp/claude-home",
      ANTHROPIC_API_KEY: "",
    };
    mkdirSync("/tmp/claude-home", { recursive: true });

    const bin = resolveClaudeBin();
    if (!bin) return { processed: 0, error: "claude binary not found" };

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
        let mem: any = await convexQuery("memory:search", { q: claim.userText, limit: 8 }).catch(() => []);
        if (!Array.isArray(mem) || mem.length === 0)
          mem = await convexQuery("memory:recent", { limit: 8 }).catch(() => []);
        const memoryContext = Array.isArray(mem)
          ? mem.map((m: any) => `- [${m.kind}] ${m.title}: ${m.body}`).join("\n").slice(0, 2000)
          : "";
        const stack: any = await convexQuery("projectState:list", {}).catch(() => []);
        const stackContext =
          Array.isArray(stack) && stack.length
            ? stack.map((s: any) => `${s.slug}=${s.status}`).join(", ").slice(0, 1200)
            : "";
        const biz: any = await convexQuery("business:list", {}).catch(() => []);
        const ins: any = await convexQuery("business:recentInsights", { limit: 5 }).catch(() => []);
        const [todos, events, wealth, widgets] = await Promise.all([
          hubQuery("todos:list"),
          hubQuery("events:list"),
          hubQuery("wealth:getWealth"),
          hubQuery("widgets:list"),
        ]);
        const bizLines = Array.isArray(biz)
          ? biz.map((b: any) => `${b.headline}${b.detail ? " " + b.detail : ""}`).join("\n")
          : "";
        const insLines =
          Array.isArray(ins) && ins.length
            ? "Insights you've noticed recently:\n" + ins.map((i: any) => `- ${i.text}`).join("\n")
            : "";
        const now = Date.now();
        const openTodos = Array.isArray(todos) ? todos.filter((t: any) => !t.done) : [];
        const todoLine = openTodos.length
          ? `To-do list (${openTodos.length} open): ${openTodos.slice(0, 10).map((t: any) => t.text).join("; ")}`
          : "To-do list is clear.";
        const upcoming = Array.isArray(events)
          ? events
              .filter((e: any) => (e.start ?? 0) >= now)
              .sort((a: any, b: any) => a.start - b.start)
              .slice(0, 5)
          : [];
        const calLine = upcoming.length
          ? "Calendar coming up: " +
            upcoming.map((e: any) => `${e.title} on ${new Date(e.start).toDateString()}`).join("; ")
          : "Nothing on the calendar coming up.";
        const wealthLine =
          wealth && typeof wealth.currentTotalGBP === "number"
            ? `Net worth is about £${Math.round(wealth.currentTotalGBP).toLocaleString("en-GB")}.`
            : "";
        const widgetLine =
          Array.isArray(widgets) && widgets.length
            ? `Dashboard widgets: ${widgets.filter((w: any) => w.enabled !== false).map((w: any) => w.type).join(", ")}.`
            : "";
        const hubLines = ["Daniel's personal hub —", todoLine, calLine, wealthLine, widgetLine]
          .filter(Boolean)
          .join("\n");
        const businessContext = [bizLines, insLines, hubLines].filter(Boolean).join("\n").slice(0, 2600);
        const model = pickModel(claim.userText);
        const turn = await runTurn(
          bin,
          env,
          claim.assistantId,
          claim.userText,
          claim.history,
          memoryContext,
          stackContext,
          businessContext,
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
          model,
        });
        // Stage 0: capture durable memory from this turn (after reply is delivered).
        if (turn.finalText.trim())
          await extractAndSave(bin, env, claim.userText, turn.finalText).catch(() => {});
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
  },
});
