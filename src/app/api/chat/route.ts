import type { NextRequest } from "next/server";
import { isToolGarbage, sanitizeAssistantText } from "@/lib/sanitize";
import { PERSONA, CAPABILITIES, REMEMBER, INFRA_MAP } from "@/lib/persona";
import { buildContext, convexMutation, reportIncident } from "@/lib/context";
import { extractMemory } from "@/lib/extract";
import { TOOL_DEFS, executeTool } from "@/lib/tools";
import { getSecret } from "@/lib/vault";

// The fast lane: every typed/spoken turn is answered here in seconds by a Groq
// reflex model with the full tool belt, streaming into Convex (the UI is
// reactive). Deep work gets dispatched to the Trigger Claude agents. The old
// cron dispatcher only handles rows this route failed to claim.
export const runtime = "nodejs";
export const maxDuration = 120;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELS = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"];

// Groq strictly validates the model's *generated* tool call against the schema
// we send. Models routinely emit `null` for optional params they don't fill
// (e.g. `max_price_per_night: null`), which 400s the turn with
// `did not match schema: expected number, but got null` even though executeTool
// coerces null away harmlessly. Widen every non-required property to also accept
// null so those calls validate. (enum props get null appended too, or `null`
// would still fail the enum constraint.)
function allowNullOnOptional(p: any): any {
  if (!p || typeof p !== "object") return p;
  if (p.type === "array" && p.items) return { ...p, items: allowNullOnOptional(p.items) };
  if (p.type !== "object" || !p.properties) return p;
  const required: string[] = Array.isArray(p.required) ? p.required : [];
  const properties: Record<string, any> = {};
  for (const [key, raw] of Object.entries(p.properties)) {
    let prop: any = allowNullOnOptional({ ...(raw as any) }); // nested objects/arrays too
    if (!required.includes(key)) {
      prop = { ...prop };
      if (typeof prop.type === "string") prop.type = [prop.type, "null"];
      else if (Array.isArray(prop.type) && !prop.type.includes("null")) prop.type = [...prop.type, "null"];
      if (Array.isArray(prop.enum) && !prop.enum.includes(null)) prop.enum = [...prop.enum, null];
    }
    properties[key] = prop;
  }
  return { ...p, properties };
}

// Groq's gpt-oss tool-call grammar chokes on parameterless functions (empty
// `properties: {}`): it emits garbage argument JSON like `{"}"` and 400s the
// turn with `tool_use_failed`. Give any such tool one harmless optional field
// so the schema is non-empty; executeTool ignores unknown args, so this is inert.
function groqToolDef(t: { name: string; description?: string; parameters?: any }) {
  const p = t.parameters;
  if (p?.type === "object" && p.properties && Object.keys(p.properties).length === 0) {
    return {
      type: "function",
      function: {
        ...t,
        parameters: {
          ...p,
          properties: { _noop: { type: ["string", "null"], description: "unused — pass an empty string" } },
        },
      },
    };
  }
  return { type: "function", function: { ...t, parameters: allowNullOnOptional(p) } };
}

async function groq(key: string, body: Record<string, unknown>): Promise<any> {
  const errs: string[] = [];
  for (const model of MODELS) {
    const payload: Record<string, unknown> = { ...body, model };
    // llama has no reasoning knob — sending it 400s the whole fallback lane
    if (!model.startsWith("openai/")) delete payload.reasoning_effort;
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.ok) return await r.json();
    errs.push(`${model}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  throw new Error(`groq failed — ${errs.join(" | ")}`);
}


// Audible progress: these tools take seconds — Daniel hears a short line the
// moment work starts instead of silence (the client speaks finalized rows).
const SLOW_LINES: Record<string, string> = {
  market_analysis: "Give me twenty seconds — pulling the chart and running the full read.",
  trip_plan: "On it — pricing real flights and stays now. The globe will fill in as I go.",
  research: "Digging into that properly — a few seconds.",
  deliberate: "Let me actually think this one through. Moment.",
  create_image: "Painting that now — a few seconds.",
  shop_search: "Out shopping — give me a few seconds.",
  plan_my_day: "Assembling your day — one moment.",
  briefing: "Pulling your briefing together — one moment.",
  orchestrate: "Spinning up the fleet now.",
  trip_finalize: "Locking it in — building the itinerary now.",
  create_pdf: "Drafting the document now.",
  news_today: "Grabbing today's front pages.",
};

// Tools that actually put something on the stage — used to catch the model
// CLAIMING "it's on your screen" in a turn where none of these ran.
const SCREEN_TOOLS = new Set([
  "show", "show_ranking", "rank_focus", "hide", "weather", "price_chart", "market_analysis", "market", "youtube_search",
  "shop_search", "news_today", "briefing", "todo_list", "net_worth", "calendar_view",
  "trip_open", "trip_plan", "trip_update", "trip_finalize", "mind_map", "board", "draft",
  "music_search", "memory_map", "transport_route", "open_app", "create_image", "create_pdf",
  "timer", "orchestrate", "creations_list", "chart", "web_search", "flight_search",
  "research", "deliberate", "plan_my_day", "rentals_calendar", "rental_availability",
  "rental_stats", "open_travel_site", "video_control",
]);
const SCREEN_CLAIM = /\bon (?:your|the) screen\b|\bup on screen\b|\bpulled (?:it |that |them )?up\b|\bshowing (?:you |it |them )?(?:now|here)\b|\bhave a look\b|\btake a look\b/i;

// THE BRAIN, v2: Claude on Daniel's Max subscription (OAuth bearer works
// directly against the Messages API — verified). Haiku answers quick turns in
// ~1-2s, Opus takes the hard ones. Groq stays as the fallback lane only.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
async function runClaude(
  key: string,
  oaiMessages: any[],
  model: string,
  progress: { toolsRan: number },
  staticSys?: string,
  dynamicSys?: string,
): Promise<{ final: string; used: string[]; screenTouched: boolean }> {
  // Prompt caching: the big STATIC prefix (persona + capabilities + infra + all
  // tool schemas) is identical every turn, so we cache it — Anthropic reuses it
  // for ~5 min, slashing time-to-first-token and cost. Only the small dynamic
  // block (live context + date) is processed fresh. Falls back to a plain string
  // if the caller didn't split it.
  const system: any = staticSys
    ? [
        { type: "text", text: staticSys, cache_control: { type: "ephemeral" } },
        ...(dynamicSys ? [{ type: "text", text: dynamicSys }] : []),
      ]
    : String(oaiMessages[0]?.content ?? "");
  const msgs: any[] = oaiMessages.slice(1).map((m: any) => ({ role: m.role === "user" ? "user" : "assistant", content: String(m.content) }));
  const tools = TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.parameters ?? { type: "object", properties: {} },
  }));
  // tighter budgets = faster to finish speaking (persona wants 1-2 sentences
  // spoken anyway; the detail goes on screen, not into a long spoken reply)
  const maxTokens = model.includes("opus") ? 1200 : model.includes("sonnet") ? 700 : 320;
  const used: string[] = [];
  let screenTouched = false;
  let interimSaid = false;
  let final = "";
  for (let round = 0; round < 6; round++) {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, system, messages: msgs, tools, max_tokens: maxTokens, temperature: 0.7 }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    const blocks: any[] = j.content ?? [];
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (toolUses.length) {
      msgs.push({ role: "assistant", content: blocks });
      let sayTimer: ReturnType<typeof setTimeout> | null = null;
      let sayFired = false;
      if (!interimSaid) {
        const line = toolUses.map((t) => SLOW_LINES[t.name]).find(Boolean);
        if (line) {
          interimSaid = true;
          sayTimer = setTimeout(() => {
            sayFired = true;
            void convexMutation("ui:say", { text: line }).catch(() => {});
          }, 1200);
        }
      }
      const results: any[] = [];
      for (const tu of toolUses) {
        used.push(tu.name);
        progress.toolsRan++;
        const result = await executeTool(tu.name, tu.input ?? {}).catch((e) => `Tool error: ${e?.message ?? e}`);
        if (SCREEN_TOOLS.has(tu.name) && !/^Tool (error|failed)/i.test(result)) screenTouched = true;
        results.push({ type: "tool_result", tool_use_id: tu.id, content: result.slice(0, 12000) });
      }
      if (sayTimer) {
        clearTimeout(sayTimer);
        if (!sayFired) interimSaid = false;
      }
      msgs.push({ role: "user", content: results });
      continue;
    }
    final = text;
    if (final && round < 5 && SCREEN_CLAIM.test(final) && !screenTouched) {
      msgs.push({ role: "assistant", content: final });
      msgs.push({
        role: "user",
        content:
          "SYSTEM NOTE: you claimed something is on Daniel's screen but no screen tool ran this turn — NOTHING is showing. Call the tool that shows THE THING YOU CLAIMED (draft with the full updated text if you were writing; weather for weather; price_chart for markets...). Never open anything unrelated. Then answer briefly.",
      });
      final = "";
      continue;
    }
    break;
  }
  return { final, used, screenTouched };
}

export async function POST(req: NextRequest) {
  let text = "",
    threadId = "main";
  try {
    const b = await req.json();
    text = String(b.text ?? "").trim();
    threadId = String(b.threadId ?? "main");
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!text) return Response.json({ error: "empty" }, { status: 400 });

  const key = process.env.GROQ_API_KEY ?? (await getSecret("groq", "GROQ_API_KEY").catch(() => ""));
  if (!key) return Response.json({ error: "no groq key" }, { status: 500 });

  const [{ assistantId, userId, history }, ctx] = await Promise.all([
    convexMutation("chatQueue:openTurn", { threadId, userText: text }),
    buildContext(text),
  ]);

  // Once the answer is finalized it is DELIVERED — nothing after that point may
  // overwrite it or re-queue the question (that's exactly how Daniel used to get
  // a cut-off bubble plus a second, reworded answer minutes later).
  let delivered = false;
  try {
    // Split so the Claude lane can cache the static half (see runClaude).
    const staticSys = `${PERSONA}\n\n${CAPABILITIES}\n\n${INFRA_MAP}`;
    const dynamicSys = `What you know right now:\n${ctx.block}\n\nCurrent date: ${new Date().toDateString()}.\n\n${REMEMBER}`;
    const messages: any[] = [
      {
        role: "system",
        content: `${staticSys}\n\n${dynamicSys}`,
      },
      ...history
        .filter(
          (h: { role: string; text: string }) =>
            !(h.role !== "user" && isToolGarbage(h.text) && !/^\[showed on screen: [^{]*\]$/.test(h.text)),
        )
        .map((h: { role: string; text: string }) => ({
          role: h.role === "user" ? "user" : "assistant",
          content: h.text,
        })),
      { role: "user", content: text },
    ];
    const tools = TOOL_DEFS.map(groqToolDef);

    // TWO-TIER BRAIN. Tier 1 is Groq's gpt-oss-120b: free, and near-instant —
    // it answers everything BASIC (chit-chat, searches, shows, quick tool calls)
    // in ~1s. Tier 2 escalates to Claude's higher intelligence ONLY for genuinely
    // hard turns: sonnet for most, opus for the very hardest. The deep reasoning
    // tools (deliberate, market_analysis) do the heavy lifting either way and now
    // run fast on Groq too, so even a Tier-1 turn can go deep without hanging.
    const complex =
      text.length > 240 ||
      /\b(design|architect|creative|brainstorm|compare|trade-?offs?|should i|which (one|is better)|pros and cons|strateg|plan out|name (it|the)|decide|recommend|story|script|character|feel(ing)?|worried|advice|honest|feedback|analy[sz]|assess|evaluate|critique|deep dive)\b/i.test(
        text,
      );
    const veryComplex =
      text.length > 600 ||
      /\b(think (really |very )?hard|think deeply|thorough(ly)?|from first principles|deep dive)\b/i.test(text);

    let final = "";
    let interimSaid = false;
    let screenTouched = false; // a screen tool ran AND did not error this turn
    const used: string[] = [];
    let brain = "flash";
    const claudeProgress = { toolsRan: 0 };
    const anthKey = process.env.ANTHROPIC_AUTH_TOKEN ?? (await getSecret("anthropic", "ANTHROPIC_AUTH_TOKEN").catch(() => ""));
    if (anthKey && (complex || veryComplex)) {
      const claudeModel = veryComplex ? "claude-opus-4-8" : "claude-sonnet-5";
      try {
        const r = await runClaude(anthKey, messages, claudeModel, claudeProgress, staticSys, dynamicSys);
        final = r.final;
        used.push(...r.used);
        screenTouched = r.screenTouched;
        brain = claudeModel.includes("opus") ? "opus" : "sonnet";
      } catch {
        // Groq picks the turn up below — UNLESS Claude already ran tools
        // (re-running them would double todos/panels/agents); then we go
        // straight to the forced-summary round.
        brain = "flash";
      }
    }
    for (let round = 0; !final && claudeProgress.toolsRan === 0 && round < 6; round++) {
      const j = await groq(key, {
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: complex ? 1100 : 700,
        reasoning_effort: complex ? "high" : "low",
      });
      const msg = j.choices?.[0]?.message;
      if (!msg) throw new Error("groq returned no message");
      if (msg.tool_calls?.length) {
        messages.push(msg);
        let sayTimer: ReturnType<typeof setTimeout> | null = null;
        let sayFired = false;
        if (!interimSaid) {
          const line = msg.tool_calls.map((tc: any) => SLOW_LINES[tc.function.name]).find(Boolean);
          if (line) {
            interimSaid = true;
            // Speak only if the work is genuinely still running after 1.2s —
            // instant validation bounces ("what's the budget?") used to get
            // "pricing flights now…" announced for work that never started.
            sayTimer = setTimeout(() => {
              sayFired = true;
              void convexMutation("ui:say", { text: line }).catch(() => {});
            }, 1200);
          }
        }
        for (const tc of msg.tool_calls) {
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* leave empty */
          }
          used.push(tc.function.name);
          const result = await executeTool(tc.function.name, args).catch((e) => `Tool error: ${e?.message ?? e}`);
          if (SCREEN_TOOLS.has(tc.function.name) && !/^Tool (error|failed)/i.test(result)) screenTouched = true;
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 12000) });
        }
        if (sayTimer) {
          clearTimeout(sayTimer);
          if (!sayFired) interimSaid = false; // fast round — a later slow round may still speak
        }
        continue;
      }
      final = String(msg.content ?? "").trim();
      // Honesty guardrail: "it's on your screen" with no screen tool run this
      // turn = the exact "he says he showed it but nothing opened" bug. Give
      // the model ONE corrective round to actually call the tool (or rephrase).
      if (final && round < 5 && SCREEN_CLAIM.test(final) && !screenTouched) {
        messages.push({ role: "assistant", content: final });
        messages.push({
          role: "system",
          content:
            "You claimed something is on Daniel's screen, but you did not call any screen tool this turn — NOTHING is showing. Call the tool that shows THE THING YOU CLAIMED (draft with the full updated text if you were writing/editing; weather for weather; price_chart for markets; youtube_search for videos...). NEVER open something unrelated to his request. Then answer briefly.",
        });
        final = "";
        continue;
      }
      break;
    }
    if (final && isToolGarbage(final) && !final.includes("```"))
      final = sanitizeAssistantText(final) || "Sorry — I mangled that reply. Ask me once more?";
    if (!final) {
      // round budget exhausted mid-toolwork: the side effects already happened,
      // so ask for a summary rather than apologising and inviting a re-ask
      // (which used to double todos/agents/panels)
      const j = await groq(key, {
        messages: [...messages, { role: "system", content: "Answer Daniel now in one or two short sentences summarising what you just did. Do not call tools." }],
        temperature: 0.6,
        max_tokens: 300,
      }).catch(() => null);
      final = String(j?.choices?.[0]?.message?.content ?? "").trim();
    }
    if (!final) final = "Sorry — lost my train of thought there. Say that again?";

    await convexMutation("chatQueue:finalize", {
      messageId: assistantId,
      threadId,
      status: "done",
      finalText: final,
      model: brain,
    });
    delivered = true;
    // Post-delivery housekeeping is strictly best-effort: a failure here must
    // NEVER reach the catch block (it used to wipe the answer + double-reply).
    if (ctx.freshFindingIds.length)
      await convexMutation("findings:markWoven", { ids: ctx.freshFindingIds }).catch(() => {});
    await extractMemory(key, text, final).catch(() => 0);
    return Response.json({ ok: true, text: final, tools: used });
  } catch (e: any) {
    await reportIncident("api/chat", `chat:${String(e?.message ?? e).slice(0, 80)}`, String(e?.message ?? e));
    if (delivered) {
      // The answer already landed — swallow the housekeeping error entirely.
      return Response.json({ ok: true });
    }
    // Hand the turn to the Trigger cron dispatcher SILENTLY: hide the dead
    // assistant row and flip the ORIGINAL user row back to pending (re-inserting
    // the text made Daniel's message appear twice and got him two answers).
    await convexMutation("chatQueue:finalize", {
      messageId: assistantId,
      threadId,
      status: "error",
      finalText: "",
    }).catch(() => {});
    if (userId) await convexMutation("chatQueue:requeueUser", { userId }).catch(() => {});
    return Response.json({ ok: false, fallback: true, error: String(e?.message ?? e) }, { status: 200 });
  }
}
