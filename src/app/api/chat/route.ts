import type { NextRequest } from "next/server";
import { PERSONA, INFRA_MAP } from "@/lib/persona";
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

async function groq(key: string, body: Record<string, unknown>): Promise<any> {
  let lastErr = "";
  for (const model of MODELS) {
    const r = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, model }),
    });
    if (r.ok) return await r.json();
    lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 200)}`;
  }
  throw new Error(`groq failed — ${lastErr}`);
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

  const [{ assistantId, history }, ctx] = await Promise.all([
    convexMutation("chatQueue:openTurn", { threadId, userText: text }),
    buildContext(text),
  ]);

  try {
    const messages: any[] = [
      {
        role: "system",
        content: `${PERSONA}\n\n${INFRA_MAP}\n\nWhat you know right now:\n${ctx.block}\n\nCurrent date: ${new Date().toDateString()}. Use tools freely — search, show things on screen, dispatch agents — but keep every spoken reply short and human.`,
      },
      ...history.map((h: { role: string; text: string }) => ({
        role: h.role === "user" ? "user" : "assistant",
        content: h.text,
      })),
      { role: "user", content: text },
    ];
    const tools = TOOL_DEFS.map((t) => ({ type: "function", function: t }));

    let final = "";
    const used: string[] = [];
    for (let round = 0; round < 6; round++) {
      const j = await groq(key, {
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 700,
        reasoning_effort: "low",
      });
      const msg = j.choices?.[0]?.message;
      if (!msg) throw new Error("groq returned no message");
      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const tc of msg.tool_calls) {
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* leave empty */
          }
          used.push(tc.function.name);
          const result = await executeTool(tc.function.name, args).catch((e) => `Tool error: ${e?.message ?? e}`);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 12000) });
        }
        continue;
      }
      final = String(msg.content ?? "").trim();
      break;
    }
    if (!final) final = "Sorry — lost my train of thought there. Say that again?";

    await convexMutation("chatQueue:finalize", {
      messageId: assistantId,
      threadId,
      status: "done",
      finalText: final,
      model: "flash",
    });
    if (ctx.freshFindingIds.length)
      await convexMutation("findings:markWoven", { ids: ctx.freshFindingIds }).catch(() => {});
    // fire-and-forget memory capture (await keeps serverless alive but it's quick)
    await extractMemory(key, text, final);
    return Response.json({ ok: true, text: final, tools: used });
  } catch (e: any) {
    await reportIncident("api/chat", `chat:${String(e?.message ?? e).slice(0, 80)}`, String(e?.message ?? e));
    // Hand the turn to the Trigger cron dispatcher SILENTLY (an empty error row
    // is hidden by the UI) — an apology bubble here meant Daniel got two spoken
    // answers for one question.
    await convexMutation("chatQueue:finalize", {
      messageId: assistantId,
      threadId,
      status: "error",
      finalText: "",
    }).catch(() => {});
    await convexMutation("chatQueue:sendMessage", { threadId, text }).catch(() => {});
    return Response.json({ ok: false, fallback: true, error: String(e?.message ?? e) }, { status: 200 });
  }
}
