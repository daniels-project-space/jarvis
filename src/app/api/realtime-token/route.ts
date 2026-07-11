import type { NextRequest } from "next/server";
import { PERSONA, INFRA_MAP } from "@/lib/persona";
import { buildContext, convexMutation, convexQuery } from "@/lib/context";
import { TOOL_DEFS } from "@/lib/tools";
import { getSecret } from "@/lib/vault";

// Live mode: mint an ephemeral OpenAI Realtime client secret with JARVIS's
// persona, fresh context, recent conversation AND the live-session lock baked
// in. The lock is enforced HERE, server-side: a second device (even one running
// a stale bundle) cannot mint a token while a session is fresh — two live
// sessions in one room hear each other and feed back in an endless loop.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return Response.json({ error: "no openai key" }, { status: 500 });

  let client = "";
  try {
    client = String((await req.json())?.client ?? "");
  } catch {
    /* legacy bundles send no body */
  }
  if (!client) client = `anon-${Math.random().toString(36).slice(2, 8)}`;
  const got = await convexMutation("ui:setLiveOn", { client, on: true }).catch(() => true);
  if (got === false)
    return Response.json(
      { error: "Live mode is already running on another device — turn it off there first." },
      { status: 409 },
    );

  const threadId = ((await convexQuery("ui:getActiveThread", {})) as string) || "main";
  const [ctx, msgs] = await Promise.all([
    buildContext(),
    convexQuery("chatQueue:listMessages", { threadId }),
  ]);

  // Recent conversation + everything recently shown, so "pull up that video
  // from earlier again" actually means something to a fresh session.
  const rows = (Array.isArray(msgs) ? msgs : []).filter((m: any) => m.status === "done").slice(-20);
  const historyLines: string[] = [];
  const shown: string[] = [];
  for (const m of rows) {
    if (m.attachment) {
      shown.push(`- "${m.attachment.title ?? m.attachment.type}" (${m.attachment.type}): ${String(m.attachment.value).slice(0, 160)}`);
      historyLines.push(`You showed on screen: ${m.attachment.title ?? m.attachment.type}`);
    } else if (m.text) {
      historyLines.push(`${m.role === "user" ? "Daniel" : "You"}: ${String(m.text).slice(0, 220)}`);
    }
  }
  const historyBlock = historyLines.length
    ? `\n\nRecent conversation (continue it naturally — this already happened):\n${historyLines.slice(-16).join("\n")}`
    : "";
  const shownBlock = shown.length
    ? `\n\nRecently shown items — re-show any of these with the show tool when he says "again"/"from earlier":\n${shown.slice(-8).join("\n")}`
    : "";

  const instructions =
    `${PERSONA}\n\n${INFRA_MAP}\n\nWhat you know right now:\n${ctx.block}${historyBlock}${shownBlock}\n\n` +
    `Current date: ${new Date().toDateString()}. This is a live voice conversation — replies of one or two short sentences, always. ` +
    `Daniel speaks English: treat everything you hear as English and reply ONLY in English, whatever it sounds like. ` +
    `When he says to turn off live mode, stop listening, or go quiet: say one short goodbye and call exit_live_mode. ` +
    `ECHO GUARD: if what you hear is a repetition or paraphrase of something YOU just said (your own voice leaking back), stay completely silent — never answer yourself.`;

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        // full gpt-realtime: mini kept claiming actions without calling tools
        model: process.env.REALTIME_MODEL || "gpt-realtime",
        instructions,
        audio: {
          input: {
            transcription: { model: "whisper-1", language: "en" }, // English-only recognition
            turn_detection: { type: "semantic_vad", eagerness: "medium" },
          },
          output: { voice: process.env.REALTIME_VOICE || "ballad" },
        },
        tools: TOOL_DEFS.map((t) => ({ type: "function", ...t })),
      },
    }),
  });
  if (!r.ok) {
    await convexMutation("ui:setLiveOn", { client, on: false }).catch(() => {});
    const err = (await r.text()).slice(0, 300);
    return Response.json({ error: `openai ${r.status}: ${err}` }, { status: 502 });
  }
  const j = await r.json();
  if (ctx.freshFindingIds.length)
    await convexMutation("findings:markWoven", { ids: ctx.freshFindingIds }).catch(() => {});
  return Response.json({ token: j.value, model: process.env.REALTIME_MODEL || "gpt-realtime", client });
}
