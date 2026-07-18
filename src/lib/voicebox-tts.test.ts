import { describe, expect, it } from "vitest";
import { voiceboxGenerationBody, voiceboxTtsConfig } from "./voicebox-tts";

describe("Voicebox cloud TTS adapter", () => {
  it("stays disabled until both the HTTPS endpoint and profile exist", () => {
    expect(voiceboxTtsConfig({})).toBeNull();
    expect(voiceboxTtsConfig({ VOICEBOX_TTS_URL: "https://voice.example" })).toBeNull();
    expect(voiceboxTtsConfig({ VOICEBOX_TTS_URL: "https://voice.example", VOICEBOX_PROFILE_ID: "jarvis" }))
      .toBeNull();
    expect(voiceboxTtsConfig({
      VOICEBOX_TTS_URL: "http://127.0.0.1:17493",
      VOICEBOX_PROFILE_ID: "jarvis",
      VOICEBOX_TTS_TOKEN: "secret",
    }))
      .toBeNull();
  });

  it("bounds the upstream latency so the no-silence fallback can still answer", () => {
    expect(voiceboxTtsConfig({
      VOICEBOX_TTS_URL: "https://voice.example/",
      VOICEBOX_PROFILE_ID: "jarvis",
      VOICEBOX_TTS_TOKEN: "secret",
      VOICEBOX_TTS_TIMEOUT_MS: "99999",
    })).toEqual({
      baseUrl: "https://voice.example",
      profileId: "jarvis",
      token: "secret",
      timeoutMs: 6_000,
    });
  });

  it("builds the exact Qwen 1.7B cloned-profile request contract", () => {
    const config = voiceboxTtsConfig({
      VOICEBOX_TTS_URL: "https://voice.example",
      VOICEBOX_PROFILE_ID: "profile-1",
      VOICEBOX_TTS_TOKEN: "secret",
    });
    expect(config).not.toBeNull();
    expect(voiceboxGenerationBody(config!, "Right here, sir.")).toMatchObject({
      profile_id: "profile-1",
      text: "Right here, sir.",
      language: "en",
      engine: "qwen",
      model_size: "1.7B",
      normalize: true,
    });
  });
});
