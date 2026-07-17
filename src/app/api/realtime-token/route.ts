import type { NextRequest } from "next/server";
import { PERSONA, VOICE_CAPABILITIES, REMEMBER } from "@/lib/persona";
import { buildContext, convexMutation } from "@/lib/context";
import { getSecret } from "@/lib/vault";
import { STT_PROMPT } from "@/lib/sttvocab";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";
import { withAdminSession } from "@/lib/control-context";

// Mint short-lived browser credentials for two deliberately separate lanes:
// - reflex: an always-warm, text-only Realtime session for instant conversation
// - live: microphone input with text output; free on-device TTS speaks the text
//
// Only live mode owns the cross-device microphone lease. A reflex connection
// must never suppress local TTS or prevent Daniel opening live mode elsewhere.
export const runtime = "nodejs";
export const maxDuration = 30;

async function handlePost(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return Response.json({ error: "no openai key" }, { status: 500 });

  let client = "";
  let mode: "live" | "reflex" = "live";
  try {
    const body = await req.json();
    client = String(body?.client ?? "");
    mode = body?.mode === "reflex" ? "reflex" : "live";
  } catch {
    /* legacy bundles send no body */
  }
  if (!client) client = `anon-${Math.random().toString(36).slice(2, 8)}`;
  const [got, ctx] = await Promise.all([
    mode === "live" ? convexMutation("ui:setLiveOn", { client, on: true }).catch(() => true) : Promise.resolve(true),
    buildContext(undefined, { includeConversation: true }),
  ]);
  if (mode === "live" && got === false)
    return Response.json(
      { error: "Live mode is already running on another device — turn it off there first." },
      { status: 409 },
    );
  const msgs = ctx.conversation ?? [];

  // Recent conversation + everything recently shown, so "pull up that video
  // from earlier again" actually means something to a fresh session. Cards are
  // rare, so scan a much wider window for them than for dialogue.
  const done = (Array.isArray(msgs) ? msgs : []).filter(
    (m): m is { status?: string; attachment?: { value?: unknown; title?: string; type?: string }; text?: string; role?: string } =>
      typeof m === "object" && m !== null && m.status === "done",
  );
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

  const laneInstructions =
    mode === "reflex"
      ? `This is Daniel's always-available reflex conversation lane. Respond immediately and naturally. Keep ordinary conversation under 30 spoken words. Use tools for real actions, visuals, current facts or delegation; never claim a tool succeeded unless it did. For substantial work, dispatch it and remain available to talk instead of trying to finish a long job inside this turn. Your text is spoken by free on-device TTS, so never emit audio or stage directions. A rare, brief human "Ha—" is fine only when genuinely amused; never write repeated laughter.`
      : `This is a live microphone conversation. Reply in one or two short sentences. Your response is text-only and is spoken by free on-device TTS; never generate model audio or written stage directions. ` +
        `When Daniel says to turn off live mode, stop listening, or go quiet: say one short goodbye and call exit_live_mode. ` +
        `ECHO GUARD: if what you hear is a repetition or paraphrase of something YOU just said (your own voice leaking back), stay completely silent — never answer yourself.`;

  const instructions =
    `${PERSONA}\n\n${VOICE_CAPABILITIES}\n\nWhat you know right now:\n${ctx.block}${historyBlock}${shownBlock}\n\n${REMEMBER}\n\n` +
    `Current date: ${new Date().toDateString()}. ${laneInstructions} ` +
    `Daniel speaks English: treat everything you hear as English and reply ONLY in English, whatever it sounds like. ` +
    `TOOLS ARE REAL FUNCTIONS: to show or do anything you MUST call the tool — NEVER type function syntax, tool names, JSON or brackets into a reply, and never read JSON, code or tool results aloud; speak a short human summary instead. If Daniel closes something on screen, it stays closed — never re-show it unless he asks again. ` +
    `NEVER claim something is on screen unless a tool call SUCCEEDED in THIS turn — earlier turns don't count, the stage tucks panels away whenever Daniel speaks. When he asks for anything visual, call the tool again even if you showed it before. If a tool fails, say so plainly instead of pretending.`;

  const model =
    mode === "reflex"
      ? process.env.REFLEX_MODEL || "gpt-realtime-2.1-mini"
      : process.env.REALTIME_MODEL || "gpt-realtime-2.1";
  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions,
        output_modalities: ["text"],
        reasoning: { effort: mode === "reflex" ? "minimal" : "low" },
        ...(mode === "live"
          ? {
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
                  turn_detection: { type: "semantic_vad", eagerness: "high" },
                  // handheld-mic noise profile: cuts ambient noise BEFORE the VAD,
                  // so breaths/room noise stop registering as barge-ins.
                  noise_reduction: { type: "near_field" },
                },
              },
            }
          : {}),
      },
    }),
  });
  if (!r.ok) {
    if (mode === "live") await convexMutation("ui:setLiveOn", { client, on: false }).catch(() => {});
    const err = (await r.text()).slice(0, 300);
    return Response.json({ error: `openai ${r.status}: ${err}` }, { status: 502 });
  }
  const j = await r.json();
  if (mode === "live" && ctx.freshFindingIds.length)
    await convexMutation("findings:markWoven", { ids: ctx.freshFindingIds }).catch(() => {});
  // The client MUST re-apply instructions + audio config after connect: the
  // agents SDK sends a session.update built from the client agent + SDK
  // defaults, clobbering everything minted here (empty instructions wiped the
  // whole persona; transcription fell back to gpt-4o-mini; noise reduction
  // nulled). The token response carries the real config for the client to own.
  return Response.json({
    token: j.value,
    model,
    mode,
    client,
    instructions,
  });
}

export async function POST(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return withAdminSession(authTokenHash, () => handlePost(req));
}
