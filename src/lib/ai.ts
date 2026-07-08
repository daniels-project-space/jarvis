import "server-only";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getServiceSecrets } from "./vault";

// Opus via OpenRouter. The vault's raw sk-ant console key is credit-depleted
// (400 "credit balance too low", 2026-07-08); OpenRouter has working credit and
// is the provider Daniel's other apps (rmv2) use. Provider pinned to the ai@6
// train (@openrouter/ai-sdk-provider@2.x).
export const JARVIS_MODEL = "anthropic/claude-opus-4.8";

let provider: ReturnType<typeof createOpenRouter> | null = null;

export async function getModel(id: string = JARVIS_MODEL) {
  if (!provider) {
    const env = await getServiceSecrets("openrouter");
    const apiKey = env.OPENROUTER_API_KEY ?? Object.values(env)[0];
    provider = createOpenRouter({ apiKey });
  }
  return provider(id);
}
