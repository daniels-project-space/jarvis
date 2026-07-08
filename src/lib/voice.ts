import "server-only";
import { getSecret } from "./vault";

// Chatterbox (Resemble AI, MIT / open source) via Replicate — free/open TTS with
// zero-shot voice cloning + emotion control. Used for JARVIS's dry-butler voice.
// NOTE: verify exact input field names against https://replicate.com/resemble-ai/chatterbox
// (or chatterbox-turbo for sub-200ms) before enabling voice in slice 5.
const CHATTERBOX_MODEL = "resemble-ai/chatterbox";

export type SpeakOpts = {
  referenceVoiceUrl?: string; // 5-20s reference clip to clone a voice
  exaggeration?: number; // emotion intensity
  temperature?: number;
};

export async function speak(text: string, opts: SpeakOpts = {}): Promise<{ audioUrl: string }> {
  const key = await getSecret("replicate", "REPLICATE_API_TOKEN");
  const input: Record<string, unknown> = { prompt: text };
  if (opts.referenceVoiceUrl) input.audio_prompt = opts.referenceVoiceUrl;
  if (opts.exaggeration != null) input.exaggeration = opts.exaggeration;
  if (opts.temperature != null) input.temperature = opts.temperature;

  const create = await fetch(`https://api.replicate.com/v1/models/${CHATTERBOX_MODEL}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input }),
  });
  if (!create.ok) throw new Error(`Chatterbox create ${create.status}: ${await create.text()}`);

  let d = await create.json();
  const id = d.id;
  const start = Date.now();
  while (d.status !== "succeeded" && Date.now() - start < 120_000) {
    if (d.status === "failed" || d.status === "canceled") throw new Error(`Chatterbox ${d.status}: ${d.error ?? "unknown"}`);
    await new Promise((res) => setTimeout(res, 1500));
    d = await (
      await fetch(`https://api.replicate.com/v1/predictions/${id}`, { headers: { Authorization: `Bearer ${key}` } })
    ).json();
  }
  const url = Array.isArray(d.output) ? d.output[0] : d.output;
  if (!url) throw new Error("Chatterbox returned no audio url");
  return { audioUrl: url };
}
