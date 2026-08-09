import type { NextRequest } from "next/server";
import { controlMutation, isSameOriginRequest } from "@/lib/control-session";
import { controlActor, controlCredentials, isOwnerActor } from "@/lib/request-auth";
import type { VoiceTurnMetric } from "@/lib/voice-turn-metrics";

const MAX_BODY_BYTES = 2_048;

function parseMetric(value: unknown): VoiceTurnMetric | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metric = value as Record<string, unknown>;
  const expected = [
    "turnId", "transcriptSource", "researchState", "researchSourceCount", "outcome",
    "captureToSpeechClosedMs", "speechClosedToTranscriptMs", "transcriptToQueuedMs",
    "queuedToFirstAudioMs", "captureToFirstAudioMs",
  ];
  if (!Object.keys(metric).every((key) => expected.includes(key))) return null;
  if (
    typeof metric.turnId !== "string"
    || (metric.transcriptSource !== "browser-final" && metric.transcriptSource !== "server")
    || !["none", "ready", "discarded", "promoted"].includes(String(metric.researchState))
    || typeof metric.researchSourceCount !== "number"
    || !["queued", "audible", "failed"].includes(String(metric.outcome))
  ) return null;
  const durations = [
    "captureToSpeechClosedMs", "speechClosedToTranscriptMs", "transcriptToQueuedMs",
    "queuedToFirstAudioMs", "captureToFirstAudioMs",
  ] as const;
  if (durations.some((key) => metric[key] !== undefined && typeof metric[key] !== "number")) return null;
  return metric as VoiceTurnMetric;
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin metric rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return Response.json({ error: "metric too large" }, { status: 413 });
  const body = await req.json().catch(() => null);
  const metric = parseMetric(body);
  if (!metric) return Response.json({ error: "invalid metric" }, { status: 400 });
  const id = await controlMutation("voiceMetrics:record", { ...metric, ...controlCredentials(actor) }).catch(() => null);
  return id
    ? Response.json({ ok: true }, { headers: { "cache-control": "private, no-store" } })
    : Response.json({ error: "metric could not be recorded" }, { status: 503 });
}
