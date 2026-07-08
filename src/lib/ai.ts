import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getSecret } from "./vault";

// Verified against the Anthropic models API (2026-07-08).
export const JARVIS_MODEL = "claude-opus-4-8";

let provider: ReturnType<typeof createAnthropic> | null = null;

// Anthropic provider keyed from the project-hub vault at runtime (no key in
// Vercel env). Returns the ai-sdk provider; call it with a model id.
export async function getAnthropic(): Promise<ReturnType<typeof createAnthropic>> {
  if (!provider) {
    const apiKey = await getSecret("anthropic", "ANTHROPIC_API_KEY");
    provider = createAnthropic({ apiKey });
  }
  return provider;
}
