import { PERSONA, INFRA_MAP } from "@/lib/persona";
import { buildContext, convexMutation } from "@/lib/context";
import { TOOL_DEFS } from "@/lib/tools";
import { getSecret } from "@/lib/vault";

// Live mode: mint an ephemeral OpenAI Realtime client secret with JARVIS's
// persona, fresh context and tool belt baked into the session. The browser
// connects to OpenAI directly over WebRTC — nothing long-lived runs here.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return Response.json({ error: "no openai key" }, { status: 500 });

  const ctx = await buildContext();
  const instructions = `${PERSONA}\n\n${INFRA_MAP}\n\nWhat you know right now:\n${ctx.block}\n\nCurrent date: ${new Date().toDateString()}. This is a live voice conversation — replies of one or two short sentences, always.`;

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: process.env.REALTIME_MODEL || "gpt-realtime-mini",
        instructions,
        audio: {
          input: { transcription: { model: "whisper-1" }, turn_detection: { type: "semantic_vad", eagerness: "medium" } },
          output: { voice: process.env.REALTIME_VOICE || "ballad" },
        },
        tools: TOOL_DEFS.map((t) => ({ type: "function", ...t })),
      },
    }),
  });
  if (!r.ok) {
    const err = (await r.text()).slice(0, 300);
    return Response.json({ error: `openai ${r.status}: ${err}` }, { status: 502 });
  }
  const j = await r.json();
  if (ctx.freshFindingIds.length)
    await convexMutation("findings:markWoven", { ids: ctx.freshFindingIds }).catch(() => {});
  return Response.json({ token: j.value, model: "gpt-realtime-mini" });
}
