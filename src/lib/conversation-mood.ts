// Fast, local mood inference for the orb. It deliberately runs in the client:
// colour should react the instant Daniel speaks, not after a model round-trip
// or a Convex mutation. The model can still use orb_mood for a nuanced shift.

export const ORB_MOODS = [
  "calm",
  "focused",
  "dreamy",
  "warm",
  "tender",
  "playful",
  "curious",
  "serious",
  "alert",
  "excited",
] as const;

export type OrbMood = (typeof ORB_MOODS)[number];

export const MOOD_COLORS: Record<OrbMood, string> = {
  calm: "#00ff88",
  focused: "#4a9eed",
  dreamy: "#9775fa",
  warm: "#ffb454",
  tender: "#ff9ec4",
  playful: "#ff7ad9",
  curious: "#33e0d0",
  serious: "#8fa3bd",
  alert: "#ff5470",
  excited: "#ff6b9c",
};

const has = (text: string, pattern: RegExp) => pattern.test(text);

/**
 * Pick the emotional register that should lead the animation right now. This
 * is intentionally conservative: bland follow-ups retain the previous tone
 * instead of flickering the orb back to green every sentence.
 */
export function inferConversationMood(input: string, previous: OrbMood = "calm"): OrbMood {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return previous;

  if (has(text, /\b(urgent|emergency|broken|failing|failed|error|not responding|stuck|security|scam|danger|panic|asap)\b/)) return "alert";
  if (has(text, /\b(sad|stressed|stress|anxious|anxiety|overwhelmed|exhausted|tired|lonely|hurt|grief|grieving|rough day)\b/)) return "tender";
  if (has(text, /\b(money|invest|investment|trade|trading|risk|bank|tax|legal|brutal|harsh|honest|decision|salary|revenue|profit)\b/)) return "serious";
  if (has(text, /\b(won|win|winning|launched|launch|shipped|finally|lets go|let's go|amazing|incredible|excited|celebrate)\b|!{2,}/)) return "excited";
  if (has(text, /\b(haha|ha ha|lol|lmao|funny|joke|banter|meme|roast)\b/)) return "playful";
  if (has(text, /\b(dream|vision|imagine|film|story|world|moodboard|aesthetic|cinematic|brand)\b/)) return "dreamy";
  if (has(text, /\b(build|fix|code|debug|audit|implement|deploy|task|project|work|roadmap|plan)\b/)) return "focused";
  if (has(text, /\b(why|how|what if|idea|think|explore|research|explain|wonder)\b|\?$/)) return "curious";
  if (has(text, /\b(hi|hello|hey|morning|afternoon|evening|thanks|thank you|appreciate|love|friend)\b/)) return "warm";

  return previous;
}
