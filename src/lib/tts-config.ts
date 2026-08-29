/** The free cloud fallback used until the self-hosted lane is explicitly enabled. */
export const EDGE_TTS_VOICE = "en-GB-RyanNeural" as const;
export const EDGE_TTS_ENGINE = "edge-neural-ryan-gb" as const;

/**
 * Kokoro's British male voice keeps Jarvis's current English voice character
 * close to Ryan without sending the spoken text to a third-party speech API.
 */
export const SELF_HOSTED_TTS_VOICE = "bm_george" as const;
export const SELF_HOSTED_TTS_ENGINE = "self-hosted-kokoro" as const;
