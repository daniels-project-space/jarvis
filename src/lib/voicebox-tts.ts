export const VOICEBOX_ENGINE = "voicebox-qwen-jarvis-1.7b";
export const VOICEBOX_VOICE = "Jarvis · cloned demo profile";

export type VoiceboxTtsConfig = {
  baseUrl: string;
  profileId: string;
  token: string;
  timeoutMs: number;
};

type VoiceboxEnvironment = Record<string, string | undefined>;

export function voiceboxTtsConfig(env: VoiceboxEnvironment = process.env): VoiceboxTtsConfig | null {
  const rawUrl = env.VOICEBOX_TTS_URL?.trim();
  const profileId = env.VOICEBOX_PROFILE_ID?.trim();
  const token = env.VOICEBOX_TTS_TOKEN?.trim();
  if (!rawUrl || !profileId || !token) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // This adapter is only for the isolated cloud service. Never turn the
  // production route into a browser-accessible proxy for a local/VPS server.
  if (url.protocol !== "https:") return null;

  const requestedTimeout = Number(env.VOICEBOX_TTS_TIMEOUT_MS);
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    profileId: profileId.slice(0, 160),
    token,
    // Leave enough of Vercel's request budget for the free neural fallback.
    timeoutMs: Math.max(1_000, Math.min(6_000, Number.isFinite(requestedTimeout) ? requestedTimeout : 5_500)),
  };
}

export function voiceboxGenerationBody(config: VoiceboxTtsConfig, text: string) {
  return {
    profile_id: config.profileId,
    text,
    language: "en",
    engine: "qwen",
    model_size: "1.7B",
    normalize: true,
    max_chunk_chars: 800,
    crossfade_ms: 0,
  };
}

export async function requestVoiceboxSpeech(
  config: VoiceboxTtsConfig,
  text: string,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${config.baseUrl}/generate/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(voiceboxGenerationBody(config, text)),
    cache: "no-store",
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Voicebox returned ${response.status}`);
  }
  return response;
}
