export type ConversationPanel = { type: string; value: string; title?: string };

const GENERIC_PANEL_TERMS = new Set([
  "analysis", "chart", "dashboard", "live", "overlay", "panel", "result", "results", "screen", "view", "widget",
]);

const ASSET_ALIASES = [
  ["btc", "bitcoin"],
  ["eth", "ethereum"],
  ["sol", "solana"],
  ["xrp", "ripple"],
  ["doge", "dogecoin"],
  ["ada", "cardano"],
  ["link", "chainlink"],
  ["avax", "avalanche"],
] as const;

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function addTerms(target: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  for (const word of words(value)) {
    if (word.length >= 2 && !GENERIC_PANEL_TERMS.has(word)) target.add(word);
  }
}

function panelDetails(panel: ConversationPanel): { kind: string; terms: Set<string> } {
  const terms = new Set<string>();
  addTerms(terms, panel.title);
  let kind = panel.type.toLowerCase();

  if (panel.type === "widget") {
    try {
      const value = JSON.parse(panel.value) as Record<string, unknown>;
      kind = String(value.kind ?? kind).toLowerCase();
      for (const key of ["title", "asset", "symbol", "label", "name", "city", "location", "destination", "query"]) {
        addTerms(terms, value[key]);
      }
      if (Array.isArray(value.items)) {
        for (const item of value.items.slice(0, 20)) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          addTerms(terms, row.name);
          addTerms(terms, row.title);
          addTerms(terms, row.label);
          addTerms(terms, row.symbol);
        }
      }
    } catch {
      // The title still provides a safe, bounded context for non-JSON panels.
    }
  }

  for (const aliases of ASSET_ALIASES) {
    if (aliases.some((alias) => terms.has(alias))) aliases.forEach((alias) => terms.add(alias));
  }
  return { kind, terms };
}

function hasPanelTerm(messageWords: Set<string>, terms: Set<string>): boolean {
  for (const term of terms) if (messageWords.has(term)) return true;
  return false;
}

function isShortContextualReference(message: string): boolean {
  const count = words(message).length;
  if (count > 10) return false;
  if (/^what(?:(?:'s| is) (?:the )?| )(?:time|date|day)\b/i.test(message)) return false;
  return (
    /^(?:and\s+)?(?:tell|show|give)\s+me\s+more\b/i.test(message) ||
    /^(?:and\s+)?(?:go on|keep going|continue|more|why|how so|what about(?:\s+(?:it|this|that))?|how about(?:\s+(?:it|this|that))?)\s*[?!.]*$/i.test(message) ||
    /\b(?:explain|expand|zoom|compare|break down|analyse|analyze|why|how|what|who)\b[^.!?]*\b(?:it|this|that|these|those|them|they|him|her|he|she)\b/i.test(message) ||
    /\b(?:it|this|that|these|those|them|they|him|her|he|she)\b[^.!?]*\b(?:mean|doing|moving|compare|work|happen|hold|changed?|drop(?:ped)?|rise|rising)\b/i.test(message) ||
    /\b(?:this|that)\s+(?:one|move|price|list|option|place|video|image|document|result)\b/i.test(message)
  );
}

/**
 * Keep the stage only when the next request actually refers to its subject or
 * affordances. Generic question words are deliberately not enough: "what's the
 * weather?" must not leave a Bitcoin chart active in UI or model context.
 */
export function isPanelFollowUp(message: string, panel: ConversationPanel): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return true;
  if (/\b(?:close|dismiss|hide|clear|remove)\b[^.!?]*\b(?:it|this|that|panel|overlay|chart|screen)\b/.test(normalized)) {
    return false;
  }

  const { kind, terms } = panelDetails(panel);
  const messageTerms = new Set(words(normalized));
  if (hasPanelTerm(messageTerms, terms)) return true;

  if (/\b(?:number|no\.?|#)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\b/.test(normalized)) return true;
  if (/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom|next|previous)\b/.test(normalized)) return true;

  if (isShortContextualReference(normalized)) return true;

  if (/candles?|market|chart/.test(kind)) {
    if (ASSET_ALIASES.some((aliases) => aliases.some((alias) => messageTerms.has(alias)))) return true;
    return /\b(?:price|candles?|market|trend|support|resistance|volume|rsi|sma|timeframe|interval|hourly|daily|weekly|bullish|bearish|breakout|pullback|move|moving|drop(?:ped)?|rise|rising|target|level|high|low|compare)\b/.test(normalized);
  }
  if (/ranking/.test(kind)) return /\b(?:rank|ranking|person|people|entry|item|option|bio|details?)\b/.test(normalized);
  if (/weather/.test(kind)) return /\b(?:weather|forecast|rain|temperature|wind|humidity|sunny|cloudy|tomorrow)\b/.test(normalized);
  if (/calendar/.test(kind)) return /\b(?:calendar|event|appointment|meeting|schedule|today|tomorrow|week|month)\b/.test(normalized);
  if (/todos?/.test(kind)) return /\b(?:todo|task|done|complete|remove|priority|today)\b/.test(normalized);
  if (/doc|markdown/.test(kind)) return /\b(?:draft|document|copy|text|paragraph|sentence|wording|shorter|longer|warmer|rewrite|edit)\b/.test(normalized);
  if (/trip/.test(kind)) return /\b(?:trip|flight|hotel|stay|activity|itinerary|budget|destination|travel)\b/.test(normalized);

  return false;
}
