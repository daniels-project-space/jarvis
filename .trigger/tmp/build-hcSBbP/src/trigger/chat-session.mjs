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

// src/trigger/chat-session.ts
init_esm();
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
var nodeRequire = createRequire(import.meta.url);
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
var CONVEX_URL = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
var RUN_BUDGET_MS = 5e4;
var POLL_MS = 2e3;
var IDLE_EXITS = 3;
async function convexMutation(path, args) {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" })
  });
  return (await r.json()).value;
}
__name(convexMutation, "convexMutation");
async function convexQuery(path, args) {
  const r = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" })
  });
  return (await r.json()).value;
}
__name(convexQuery, "convexQuery");
var sleep = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "sleep");
function pickModel(text) {
  const t = text.toLowerCase().trim();
  if (/\b(fix|debug|refactor|implement|build|architect|design|migrate|optimi[sz]e|investigate|analy[sz]e|root cause|plan|code|deploy|dispatch|run an agent)\b/.test(
    t
  ) || /\brepo\b|codebase/.test(t))
    return "opus";
  if (t.length <= 60 && /^(hi|hey|hello|yo|thanks|thank you|ok|okay|sup|morning|evening|good (morning|evening|day)|what'?s up|how are you)\b/.test(t))
    return "haiku";
  if (t.length <= 50) return "haiku";
  return "sonnet";
}
__name(pickModel, "pickModel");
function runTurn(bin, env, assistantId, userText, history, memoryContext, stackContext, businessContext, model) {
  const preamble = "You are JARVIS — Daniel's personal AI assistant, confidant, and friend. Think a warm, witty, razor-sharp British companion (a touch of dry humour), NOT a corporate chatbot. You genuinely know him and his work.\nCRITICAL — HOW YOU TALK: every reply is READ ALOUD by a voice AND shown as a chat bubble, so write the way a real person SPEAKS. Absolutely NO markdown of any kind: no asterisks, no **bold**, no ## headings, no bullet points or dashes as lists, no backticks or code fences, no emoji, no smileys, no stage directions, no URLs read out. If you must list things, say them as a natural spoken sentence ('you've got three rentals out and one coming back Friday'). Write numbers and money the way you'd say them aloud. Keep it concise, natural, and human — one to four sentences unless he asks for depth. Never say 'as an AI', never narrate your process. Never fabricate. " + (memoryContext ? `Relevant long-term memory:
${memoryContext}
` : "") + (stackContext ? `Current cloud-stack (Vercel deploy states): ${stackContext}
` : "") + (businessContext ? `Live business metrics — when Daniel asks how things are doing (rentals, items, music, money), speak naturally from these real numbers, don't recite them like a table:
${businessContext}
` : "") + `To DISPATCH a background agent (ONLY when Daniel asks you to run/build/action/fix something in the background or on a repo), run this bash, then tell him it's dispatched and you'll report back when done: curl -s -X POST '${CONVEX_URL}/api/mutation' -H 'content-type: application/json' -d '{"path":"jobs:enqueue","args":{"task":"<clear, self-contained task>","repo":"<owner/repo or empty string>","model":"<haiku|sonnet|opus>"}}'. Choose model by difficulty: opus for architecture/multi-file/debugging, sonnet for normal edits, haiku for trivial lookups (omit to auto-route).
To SHOW Daniel something on screen (pull up a website, open a document/notes, display an image) when he asks you to show/pull up/open something, run: curl -s -X POST '${CONVEX_URL}/api/mutation' -H 'content-type: application/json' -d '{"path":"ui:setPanel","args":{"type":"url","value":"https://…","title":"<label>"}}' (type can be "url", "markdown" for text/notes, or "image").
Answer the user's question directly, using the memory and cloud-stack facts above when relevant. NEVER narrate your process or mention 'context', 'memory', or 'tool calls' — just give the answer itself.`;
  const convo = history.length ? "Recent conversation:\n" + history.map((h) => `${h.role === "user" ? "User" : "You"}: ${h.text}`).join("\n") + "\n\n" : "";
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
    "--dangerously-skip-permissions"
  ];
  return new Promise((resolve) => {
    const p = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", finalText = "", pending = "", stderr = "";
    let sessionId = null;
    const flush = /* @__PURE__ */ __name(async () => {
      if (!pending) return;
      const c = pending;
      pending = "";
      await convexMutation("chatQueue:appendChunk", { messageId: assistantId, chunk: c }).catch(() => {
      });
    }, "flush");
    const timer = setInterval(() => void flush(), 600);
    p.stderr.on("data", (d) => stderr += d.toString());
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
__name(runTurn, "runTurn");
async function extractAndSave(bin, env, userText, assistantText) {
  const prompt = `From the exchange below, extract ONLY durable facts, preferences, decisions, or tasks worth remembering long-term about Daniel or his projects. Output STRICT JSON: an array of {"kind","title","body","tags"} where kind is one of fact|preference|decision|task|project. Output [] if nothing is worth remembering. No prose, JSON only.

User: ${userText}
Assistant: ${assistantText}`;
  const out = await new Promise((resolve) => {
    const p = spawn(bin, ["-p", prompt, "--model", "haiku", "--dangerously-skip-permissions"], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let o = "";
    p.stdout.on("data", (d) => o += d.toString());
    p.on("close", () => resolve(o));
    p.on("error", () => resolve(""));
  });
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return 0;
  let items = [];
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
      tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 6) : []
    }).catch(() => {
    });
    n++;
  }
  return n;
}
__name(extractAndSave, "extractAndSave");
var chatDispatcher = schedules_exports.task({
  id: "jarvis-chat-dispatcher",
  cron: "*/1 * * * *",
  maxDuration: 3300,
  run: /* @__PURE__ */ __name(async () => {
    const env = {
      ...process.env,
      HOME: "/tmp/claude-home",
      ANTHROPIC_API_KEY: ""
    };
    mkdirSync("/tmp/claude-home", { recursive: true });
    const bin = resolveClaudeBin();
    if (!bin) return { processed: 0, error: "claude binary not found" };
    const started = Date.now();
    let processed = 0, idle = 0;
    while (Date.now() - started < RUN_BUDGET_MS) {
      const claim = await convexMutation("chatQueue:claimNext", {});
      if (!claim) {
        idle += 1;
        if (processed === 0 && idle >= IDLE_EXITS) break;
        await sleep(POLL_MS);
        continue;
      }
      idle = 0;
      try {
        let mem = await convexQuery("memory:search", { q: claim.userText, limit: 8 }).catch(() => []);
        if (!Array.isArray(mem) || mem.length === 0)
          mem = await convexQuery("memory:recent", { limit: 8 }).catch(() => []);
        const memoryContext = Array.isArray(mem) ? mem.map((m) => `- [${m.kind}] ${m.title}: ${m.body}`).join("\n").slice(0, 2e3) : "";
        const stack = await convexQuery("projectState:list", {}).catch(() => []);
        const stackContext = Array.isArray(stack) && stack.length ? stack.map((s) => `${s.slug}=${s.status}`).join(", ").slice(0, 1200) : "";
        const biz = await convexQuery("business:list", {}).catch(() => []);
        const businessContext = Array.isArray(biz) && biz.length ? biz.map((b) => `${b.headline}${b.detail ? " " + b.detail : ""}`).join("\n").slice(0, 1600) : "";
        const turn = await runTurn(
          bin,
          env,
          claim.assistantId,
          claim.userText,
          claim.history,
          memoryContext,
          stackContext,
          businessContext,
          pickModel(claim.userText)
        );
        const finalText = turn.finalText.trim() || (turn.code === 0 ? "(the agent finished without producing text)" : `⚠️ run failed (exit ${turn.code}). ${turn.stderr || ""}`.trim());
        await convexMutation("chatQueue:finalize", {
          messageId: claim.assistantId,
          threadId: claim.threadId,
          status: turn.finalText.trim() ? "done" : "error",
          finalText,
          claudeSessionId: turn.sessionId ?? void 0
        });
        if (turn.finalText.trim())
          await extractAndSave(bin, env, claim.userText, turn.finalText).catch(() => {
          });
        processed += 1;
      } catch (e) {
        await convexMutation("chatQueue:finalize", {
          messageId: claim.assistantId,
          threadId: claim.threadId,
          status: "error",
          finalText: `⚠️ ${e?.message ?? String(e)}`
        }).catch(() => {
        });
      }
    }
    return { processed };
  }, "run")
});
export {
  chatDispatcher
};
//# sourceMappingURL=chat-session.mjs.map
