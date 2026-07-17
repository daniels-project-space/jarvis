// Speech is deliberately generated on-device with the browser's Web Speech
// engine. Keeping this retired endpoint prevents stale clients from silently
// spending ElevenLabs or Replicate credits while they refresh onto the current
// bundle.
export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { error: "Hosted TTS is disabled; Jarvis uses free on-device speech." },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
