export type CurrentStateFact = {
  key: "profile.current_location";
  value: string;
  confidence: number;
  validForMs: number;
};

// A conversational "I'm in …" is useful current context, not durable location.
// Browser GPS has an even shorter freshness window in live-location.ts.
export const CURRENT_LOCATION_TTL_MS = 12 * 60 * 60 * 1000;
const NON_PLACES = /^(?:a |an |the )?(?:bed|home|here|there|trouble|love|pain|a rush|no hurry|the kitchen|the office|the city|the car)$/i;

/** Extract only high-confidence, first-person current state. This deliberately
 * avoids an LLM call and never stores the raw utterance. */
export function extractCurrentStateFacts(input: string): CurrentStateFact[] {
  const text = input.replace(/\s+/g, " ").trim().slice(0, 1_200);
  if (!text || /^(?:where|what|am i|are we|do you know)\b/i.test(text) || /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are)\s+(?:not|no longer)\b/i.test(text)) {
    return [];
  }
  const match = text.match(
    /(?:^|[.!?]\s+)(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are)\s+(?:(currently|right now)\s+)?(?:(staying|based|located)\s+)?(?:in|at)\s+([^\n,.!?;]{2,80}?)(?=\s+(?:right now|at the moment|currently|for\s+(?:the|a|\d)|until|today|this\s+week)\b|[,.;!?]|$)/i,
  );
  if (!match) return [];
  const value = match[3].replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "");
  const explicitCurrent = Boolean(match[1]) || /\b(?:right now|at the moment|currently)\b/i.test(text);
  const explicitLocation = Boolean(match[2]);
  const startsLikeProperPlace = /^\p{Lu}/u.test(value);
  if (!value || value.split(/\s+/).length > 6 || NON_PLACES.test(value)) return [];
  if (!explicitCurrent && !explicitLocation && !startsLikeProperPlace) return [];
  return [{
    key: "profile.current_location",
    value,
    confidence: explicitCurrent || explicitLocation ? 0.99 : 0.94,
    validForMs: CURRENT_LOCATION_TTL_MS,
  }];
}

/** Gate the expensive semantic memory extractor to genuinely durable facts.
 * Ordinary questions and work instructions already remain in private chat and
 * should not launch another Trigger/Codex session. */
export function shouldCaptureDurableMemory(input: string): boolean {
  const text = input.replace(/\s+/g, " ").trim().slice(0, 1_200);
  if (!text || text.endsWith("?") || extractCurrentStateFacts(text).length) return false;
  return /\b(?:remember(?: that| this)?|don['’]?t forget|for future reference|from now on|i (?:prefer|always|never|decided|have|own|use|live|work)|my [a-z][a-z -]{1,40} is|we (?:decided|always|never|use))\b/i.test(text);
}
