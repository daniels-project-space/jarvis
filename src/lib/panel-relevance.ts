export type PanelTopic = { title?: string };

const GENERIC_TITLE_WORDS = new Set([
  "chart",
  "dashboard",
  "live",
  "panel",
  "results",
  "screen",
  "view",
]);

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Decide whether a new turn still refers to the panel already on screen.
 *
 * Generic pronouns are only useful in short, deictic follow-ups. Treating any
 * occurrence of "it" or "that" as panel context made long topic switches keep
 * stale charts open indefinitely.
 */
export function isPanelFollowUp(message: string, panel: PanelTopic): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;

  // A complaint that an old visual is still present is itself a dismissal,
  // even when it names the visual.
  if (
    /\b(?:chart|dashboard|overlay|panel|screen|view)\b/.test(text) &&
    /\b(?:still|stuck|left|keeps? being)\s+(?:open|up|visible|showing)\b/.test(text)
  ) {
    return false;
  }

  if (/\b(?:number|no\.?|#|box|option|item|pic|picture|photo)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b/.test(text)) return true;
  if (/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom)\b/.test(text)) return true;
  if (
    words(text).length <= 10 &&
    (/(?:\b(?:next|previous)\s+(?:one|item|result|option|picture|photo|page|slide|entry)\b)/.test(text)
      || /\b(?:show|open|select|choose|highlight|visit|go to|move to)\s+(?:me\s+)?(?:the\s+)?(?:next|previous)\b/.test(text))
  ) return true;
  if (/\b(?:zoom|expand|focus|highlight)\b/.test(text)) return true;

  const titleWords = words(panel.title ?? "").filter(
    (word) => word.length >= 3 && !GENERIC_TITLE_WORDS.has(word),
  );
  const messageWords = new Set(words(text));
  if (titleWords.some((word) => messageWords.has(word))) return true;

  const wordCount = words(text).length;
  if (wordCount > 16) return false;

  // Short phrases such as "tell me more about that" or "why is it down?"
  // naturally point at the current visual. A pronoun buried in a long request
  // does not.
  return /^(?:and\s+)?(?:can|could|would|will|do|does|did|is|are|was|were|why|how|what|who|where|tell|show|make|open|close|hide|more)\b[\s\S]*\b(?:this|that|it|these|those|they|them|their|there|him|his|her|hers)\b/.test(text)
    || /^(?:and\s+)?(?:this|that|it|these|those|they|them|there)\b/.test(text)
    || /^(?:and\s+)?(?:more|tell me|what about|how about|go on|continue)\b/.test(text);
}
