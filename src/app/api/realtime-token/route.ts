import type { NextRequest } from "next/server";
import { PERSONA } from "@/lib/persona";
import { buildContext, convexMutation, convexQuery } from "@/lib/context";
import { TOOL_DEFS } from "@/lib/tools";
import { getSecret } from "@/lib/vault";
import { STT_PROMPT } from "@/lib/sttvocab";

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
  // from earlier again" actually means something to a fresh session. Cards are
  // rare, so scan a much wider window for them than for dialogue.
  const done = (Array.isArray(msgs) ? msgs : []).filter((m: any) => m.status === "done");
  const shown: string[] = [];
  for (const m of done.slice(-60)) {
    if (m.attachment) {
      // Titles and URLs only — raw widget JSON in the prompt taught the model
      // to parrot JSON blobs into its spoken replies.
      const val = String(m.attachment.value);
      shown.push(
        `- "${m.attachment.title ?? m.attachment.type}" (${m.attachment.type})${/^https?:/.test(val) ? `: ${val.slice(0, 120)}` : ""}`,
      );
    }
  }
  const historyLines: string[] = [];
  for (const m of done.slice(-20)) {
    if (m.attachment) historyLines.push(`You showed on screen: ${m.attachment.title ?? m.attachment.type}`);
    else if (m.text && !/<function|\{"kind"\s*:|\[showed on screen:/i.test(m.text))
      historyLines.push(`${m.role === "user" ? "Daniel" : "You"}: ${String(m.text).slice(0, 150)}`);
  }
  const historyBlock = historyLines.length
    ? `\n\nRecent conversation (continue it naturally — this already happened):\n${historyLines.slice(-10).join("\n")}`
    : "";
  const shownBlock = shown.length
    ? `\n\nItems shown EARLIER — NOT currently visible. Re-show ONE only when Daniel explicitly asks to see THAT item again; never re-show on your own:\n${shown.slice(-5).join("\n")}`
    : "";

  const instructions =
    `${PERSONA}\n\nWhat you know right now:\n${ctx.block}${historyBlock}${shownBlock}\n\n` +
    `Current date: ${new Date().toDateString()}. This is a live voice conversation — replies of one or two short sentences, always. ` +
    `Daniel speaks English: treat everything you hear as English and reply ONLY in English, whatever it sounds like. ` +
    `When he says to turn off live mode, stop listening, or go quiet: say one short goodbye and call exit_live_mode. ` +
    `ECHO GUARD: if what you hear is a repetition or paraphrase of something YOU just said (your own voice leaking back), stay completely silent — never answer yourself. ` +
    `TOOLS ARE REAL FUNCTIONS: to show or do anything you MUST call the tool — NEVER type function syntax, tool names, JSON or brackets into a reply, and never read JSON, code or tool results aloud; speak a short human summary instead. If Daniel closes something on screen, it stays closed — never re-show it unless he asks again. ` +
    `NEVER claim something is on screen unless a tool call SUCCEEDED in THIS turn — earlier turns don't count, the stage tucks panels away whenever Daniel speaks. When he asks for anything visual, call the tool again even if you showed it before. If a tool fails, say so plainly instead of pretending.`;

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        // full gpt-realtime: mini kept claiming actions without calling tools
        model: process.env.REALTIME_MODEL || "gpt-realtime-2.1",
        instructions,
        audio: {
          input: {
            // gpt-4o-transcribe + language pin + English prompt: whisper-1 was
            // hallucinating foreign-language transcripts on noise/accent.
            transcription: {
              model: "gpt-4o-transcribe",
              language: "en",
              // vocabulary-primed: proper nouns (apps, gear, providers) come out right
              prompt: STT_PROMPT,
            },
            turn_detection: { type: "semantic_vad", eagerness: "medium" },
            // handheld-mic noise profile: cuts ambient noise BEFORE the VAD,
            // so breaths/room noise stop registering as barge-ins that cancel
            // JARVIS mid-sentence (phones were worst)
            noise_reduction: { type: "near_field" },
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
  return Response.json({ token: j.value, model: process.env.REALTIME_MODEL || "gpt-realtime-2.1", client });
}
