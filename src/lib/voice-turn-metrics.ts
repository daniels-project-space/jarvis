export const VOICE_TURN_METRIC_LIMITS = Object.freeze({
  turnIdChars: 120,
  maxDurationMs: 10 * 60_000,
  maxSourceCount: 12,
});

export const VOICE_TURN_METRIC_POLICY = Object.freeze({
  // Fast successful turns are sampled to keep the normal path effectively free.
  // Failures and slow audible turns are always retained below.
  sampleModulo: 20,
  slowAudibleMs: 8_000,
});

export type VoiceTranscriptSource = "browser-final" | "server";
export type VoiceEndpointStrategy = "standard" | "trusted-browser-final";
export type VoiceResearchState = "none" | "ready" | "discarded" | "promoted";
export type VoiceTurnOutcome = "queued" | "audible" | "failed";

export type VoiceTurnTrace = {
  turnId: string;
  startedAt: number;
  speechClosedAt?: number;
  transcriptReadyAt?: number;
  queuedAt?: number;
  firstAudioAt?: number;
  transcriptSource?: VoiceTranscriptSource;
  endpointStrategy?: VoiceEndpointStrategy;
  researchState?: VoiceResearchState;
  researchSourceCount?: number;
};

export type VoiceTurnMetric = {
  turnId: string;
  transcriptSource: VoiceTranscriptSource;
  endpointStrategy: VoiceEndpointStrategy;
  researchState: VoiceResearchState;
  researchSourceCount: number;
  outcome: VoiceTurnOutcome;
  captureToSpeechClosedMs?: number;
  speechClosedToTranscriptMs?: number;
  transcriptToQueuedMs?: number;
  queuedToFirstAudioMs?: number;
  captureToFirstAudioMs?: number;
};

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function sampledTurnId(turnId: string): boolean {
  let hash = 0x811c9dc5;
  for (let index = 0; index < turnId.length; index += 1) {
    hash ^= turnId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % VOICE_TURN_METRIC_POLICY.sampleModulo === 0;
}

function boundedDuration(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= VOICE_TURN_METRIC_LIMITS.maxDurationMs ? rounded : undefined;
}

function boundedCount(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 0;
  return Math.max(0, Math.min(VOICE_TURN_METRIC_LIMITS.maxSourceCount, Math.floor(value)));
}

/**
 * Serializes only bounded durations and categorical outcomes. Transcript text,
 * timestamps, device details, and errors must never leave the browser here.
 */
export function buildVoiceTurnMetric(trace: VoiceTurnTrace, outcome: VoiceTurnOutcome): VoiceTurnMetric | null {
  const turnId = trace.turnId.trim();
  if (!TURN_ID.test(turnId) || turnId.length > VOICE_TURN_METRIC_LIMITS.turnIdChars) return null;
  if (!Number.isFinite(trace.startedAt)) return null;

  const firstAudioAt = outcome === "audible" ? trace.firstAudioAt : undefined;
  return {
    turnId,
    transcriptSource: trace.transcriptSource ?? "server",
    endpointStrategy: trace.endpointStrategy ?? "standard",
    researchState: trace.researchState ?? "none",
    researchSourceCount: boundedCount(trace.researchSourceCount),
    outcome,
    captureToSpeechClosedMs: boundedDuration(
      trace.speechClosedAt === undefined ? undefined : trace.speechClosedAt - trace.startedAt,
    ),
    speechClosedToTranscriptMs: boundedDuration(
      trace.speechClosedAt === undefined || trace.transcriptReadyAt === undefined
        ? undefined
        : trace.transcriptReadyAt - trace.speechClosedAt,
    ),
    transcriptToQueuedMs: boundedDuration(
      trace.transcriptReadyAt === undefined || trace.queuedAt === undefined
        ? undefined
        : trace.queuedAt - trace.transcriptReadyAt,
    ),
    queuedToFirstAudioMs: boundedDuration(
      trace.queuedAt === undefined || firstAudioAt === undefined
        ? undefined
        : firstAudioAt - trace.queuedAt,
    ),
    captureToFirstAudioMs: boundedDuration(
      firstAudioAt === undefined ? undefined : firstAudioAt - trace.startedAt,
    ),
  };
}

/**
 * Keeps production observability without paying for two Convex mutations on
 * every healthy voice turn. A stable 5% cohort records queue and audible
 * transitions; all failures and slow audible turns bypass sampling.
 */
export function shouldRecordVoiceTurnMetric(metric: VoiceTurnMetric): boolean {
  if (metric.outcome === "failed") return true;
  if (
    metric.outcome === "audible"
    && metric.captureToFirstAudioMs !== undefined
    && metric.captureToFirstAudioMs >= VOICE_TURN_METRIC_POLICY.slowAudibleMs
  ) return true;
  return sampledTurnId(metric.turnId);
}
