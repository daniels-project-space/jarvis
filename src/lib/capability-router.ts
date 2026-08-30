import {
  FOREGROUND_OWNER_TOOL_NAMES,
  SUBSCRIPTION_TOOL_NAMES,
  TOOL_BELT_NAMES,
  TOOL_BELTS,
  type ToolBeltName,
} from "./tool-belts";

export type CapabilityCandidate = {
  belt: ToolBeltName;
  tool: string;
  score: number;
  visual: boolean;
  reason: string;
};

export type CapabilityRanking = {
  candidates: CapabilityCandidate[];
  explicitVisual: boolean;
};

export type CapabilityRoutingOptions = {
  activeTool?: string;
  limit?: number;
  /**
   * Enables the separate, turn-fenced owner foreground catalog. Normal
   * subscription workers never set this and therefore never discover Gmail or
   * iCloud Calendar capabilities.
   */
  ownerForeground?: boolean;
  /**
   * Exact owner-only definitions minted at authenticated message admission
   * and carried by the active claim. Never derive these from `intent`.
   */
  ownerToolNames?: readonly string[];
  /**
   * Admission-persisted companion scope for the normal Hub to-do mutation.
   * It is valid only alongside an admitted Calendar-create capability.
   */
  ownerCalendarAndHubTodo?: boolean;
};

type CapabilityRule = {
  belt: ToolBeltName;
  tools: readonly string[];
  score: number;
  visual: boolean;
  reason: string;
  matches: (normalized: string, original: string) => boolean;
};

const EXPLICIT_VISUAL_RE = /\b(?:show|display|open|visuali[sz]e|map|chart|graph|plot|dashboard|widget|calendar|board|canvas|diagram|timeline)\b/i;
const CONTINUATION_RE = /\b(?:more|other|another|instead|niche|less touristy|nearby|around there|add|remove|replace|change)\b/i;
const PLACE_ROUTE_RE = /^\s*[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){0,2}\s+(?:to|→)\s+[\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+){0,2}\s*$/iu;
const YOUTUBE_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[\w-]{11}/i;

const includesAny = (value: string, patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(value));

function looksLikePlaceToPlaceRoute(original: string): boolean {
  if (!PLACE_ROUTE_RE.test(original)) return false;
  const nonPlaceWords = /\b(?:how|what|when|where|why|who|i|we|you|they|draft|write|email|message|make|show|display|need|want|like|something|anything|everything|consider|do|go|get|set|add|change|reply|respond|talk|say)\b/i;
  return !nonPlaceWords.test(original);
}

const RULES: readonly CapabilityRule[] = [
  {
    belt: "core",
    tools: ["review_uploaded_file"],
    score: 178,
    visual: false,
    reason: "attached_file_review",
    matches: (value) => /\b(?:favorite|favourite)\b.{0,40}\b(?:file|document|upload|image|photo|picture)\b|\b(?:mark|flag|set)\b.{0,40}\b(?:this|that|attached|uploaded|file|document|image|photo).{0,40}\b(?:review\s+)?remov(?:al|e)\b|\b(?:clear|reset|remove)\b.{0,40}\breview(?:\s+(?:state|status|mark))?\b/i.test(value),
  },
  {
    belt: "core",
    tools: ["organize_uploaded_file"],
    score: 177,
    visual: false,
    reason: "attached_file_organization",
    matches: (value) => /\b(?:rename|move|file|organize|organise|tag)\b.{0,60}\b(?:file|document|upload|image|photo|folder|tag|tags)\b/i.test(value),
  },
  {
    belt: "business",
    tools: ["price_chart", "market_analysis", "market"],
    score: 180,
    visual: true,
    reason: "crypto_or_market_chart",
    matches: (value) => /\b(?:bitcoin|btc|ethereum|ether|eth|solana|sol|crypto(?:currency)?|token|coin|candles?|ohlc)\b/i.test(value),
  },
  {
    belt: "travel",
    tools: ["travel_map", "places_near", "transport_route"],
    score: 175,
    visual: true,
    reason: "travel_map_or_itinerary",
    matches: (value, original) => (!/\b(?:mind|concept)[ -]?map\b/i.test(value) && includesAny(value, [
      /\b(?:map|attractions?|sightseeing|waypoints?|points? of interest|touristy|niche places?|niche spots?|things to do|places to (?:see|visit)|around the city)\b/i,
      /\b(?:best route|walking route|driving route|directions?|city itinerary|day itinerary)\b/i,
    ])) || looksLikePlaceToPlaceRoute(original),
  },
  {
    belt: "core",
    tools: ["weather"],
    score: 170,
    visual: true,
    reason: "weather",
    matches: (value) => /\b(?:weather|forecast|temperature|rain(?:ing|y)?|snow(?:ing|y)?|wind(?:y)?|sunny|umbrella)\b/i.test(value),
  },
  {
    belt: "core",
    tools: ["briefing"],
    score: 165,
    visual: true,
    reason: "briefing",
    matches: (value) => /\b(?:(?:morning|daily|today'?s|evening) briefing|brief me|daily overview|morning overview)\b/i.test(value),
  },
  {
    belt: "creative",
    tools: ["mind_map", "board"],
    score: 160,
    visual: true,
    reason: "mind_map_or_board",
    matches: (value) => /\b(?:mind[ -]?map|concept map|brainstorm board|kanban|mood ?board|planning board|project board)\b/i.test(value),
  },
  {
    belt: "creative",
    tools: ["chart"],
    score: 150,
    visual: true,
    reason: "general_chart",
    matches: (value) => /\b(?:chart|graph|plot|visuali[sz]e (?:these|this|the) data|data visuali[sz]ation)\b/i.test(value),
  },
  {
    belt: "creative",
    tools: ["youtube_transcript"],
    score: 149,
    visual: true,
    reason: "youtube_url_transcript",
    matches: (_value, original) => YOUTUBE_URL_RE.test(original),
  },
  {
    belt: "creative",
    tools: ["youtube_search"],
    score: 148,
    visual: true,
    reason: "youtube_video_discovery",
    matches: (value, original) => !YOUTUBE_URL_RE.test(original)
      && !/\byoutube\s+studio\b/i.test(value)
      && /\b(?:youtube|yt)\b/i.test(value)
      && /\b(?:find|search|watch|video|videos|creator|channel|clip|playlist|transcript|summari[sz]e)\b/i.test(value),
  },
  {
    belt: "core",
    tools: ["web_search"],
    score: 145,
    visual: true,
    reason: "web_search",
    matches: (value) => !/\b(?:google\s*calendar|gcal)\b/i.test(value)
      && /\b(?:search (?:the )?(?:web|internet|online)|look (?:it|this|that)?\s*up|find (?:me )?(?:online|current|latest)|search results?|google)\b/i.test(value),
  },
  {
    belt: "work",
    tools: ["research", "web_search"],
    score: 138,
    visual: true,
    reason: "research",
    matches: (value) => /\b(?:research|investigate|compare sources?|source this|fact[ -]?check)\b/i.test(value),
  },
  {
    belt: "creative",
    tools: ["draft"],
    score: 135,
    visual: true,
    reason: "writing",
    matches: (value) => /\b(?:draft|write|rewrite|edit|compose)\b[\s\S]{0,40}\b(?:email|message|reply|response|letter|document|article|report|essay|story|caption|description|copy|post|script|outline|proposal|note)\b|\b(?:email|letter|copy|script|article|report)\b[\s\S]{0,24}\b(?:draft|rewrite)\b/i.test(value),
  },
  {
    belt: "work",
    tools: ["plan_my_day", "show", "calendar_view", "todo_list"],
    score: 130,
    visual: true,
    reason: "day_planning",
    matches: (value) => /\b(?:plan (?:my )?(?:day|today|tomorrow|week)|organize my day|schedule my day|day plan|daily plan|today'?s plan|prioriti[sz]e my (?:day|tasks))\b/i.test(value),
  },
  {
    belt: "core",
    tools: ["calendar_view"],
    score: 125,
    visual: true,
    reason: "calendar_view",
    matches: (value) => /\b(?:show|open|view|display|what(?:'s| is) on)\b[\s\S]{0,24}\b(?:calendar|schedule|agenda)\b/i.test(value),
  },
  {
    belt: "travel",
    tools: ["bookings_lookup", "bookings_check", "trip_open", "trip_plan", "trip_update", "flight_search"],
    score: 120,
    visual: true,
    reason: "travel",
    matches: (value) => /\b(?:trip|travel|flight|hotel|booking|reservation|airport|train|journey|destination|check[ -]?in|check[ -]?out)\b/i.test(value),
  },
];

export function beltsForTool(toolName: string): ToolBeltName[] {
  return TOOL_BELT_NAMES.filter((belt) => TOOL_BELTS[belt].has(toolName));
}

export function rankCapabilities(
  intent: string,
  options: CapabilityRoutingOptions = {},
): CapabilityRanking {
  const original = String(intent ?? "").trim().slice(0, 2_000);
  const normalized = original.replace(/\s+/g, " ").toLowerCase();
  const explicitVisual = EXPLICIT_VISUAL_RE.test(normalized);
  const ranked = new Map<string, CapabilityCandidate>();
  const ownerToolNames = options.ownerForeground
    ? [...new Set(options.ownerToolNames ?? [])].filter((name) => FOREGROUND_OWNER_TOOL_NAMES.has(name))
    : [];
  const ownerCalendarAndHubTodo = options.ownerForeground
    && options.ownerCalendarAndHubTodo === true
    && ownerToolNames.includes("icloud_calendar_create");
  const allowedToolNames = new Set(SUBSCRIPTION_TOOL_NAMES);
  ownerToolNames.forEach((name) => allowedToolNames.add(name));
  // A foreground owner turn has an additional authority boundary. Prevent a
  // model-supplied `activeTool` or explicit belt from surfacing the Hub to-do
  // unless the original owner command minted this exact companion scope.
  if (options.ownerForeground && !ownerCalendarAndHubTodo) {
    allowedToolNames.delete("todo_add");
  }

  const add = (candidate: CapabilityCandidate) => {
    if (!TOOL_BELTS[candidate.belt].has(candidate.tool) || !allowedToolNames.has(candidate.tool)) return;
    const previous = ranked.get(candidate.tool);
    if (!previous || candidate.score > previous.score) ranked.set(candidate.tool, candidate);
  };

  for (const rule of RULES) {
    if (!rule.matches(normalized, original)) continue;
    rule.tools.forEach((tool, index) => add({
      belt: rule.belt,
      tool,
      score: rule.score - index * 3,
      visual: rule.visual,
      reason: rule.reason,
    }));
  }

  // Mailbox and Calendar access are deliberately not a general tool
  // rule. This only chooses a foreground discovery lane; the endpoint grants
  // definitions solely from the direct-command scope recorded at admission.
  if (options.ownerForeground) {
    ownerToolNames.forEach((tool, index) => {
      const belt = beltsForTool(tool)[0];
      if (!belt) return;
      add({
        belt,
        tool,
        score: 188 - index * 2,
        visual: false,
        reason: tool.startsWith("gmail_") || tool === "email_support"
          ? "owner_gmail"
          : tool === "browser_errand_run"
            ? "owner_browser_errand"
            : "owner_icloud_calendar",
      });
    });
    // The dual destination scope was fixed at owner-message admission and is
    // carried in the active claim. Never infer it from dynamic model intent.
    if (ownerCalendarAndHubTodo) {
      add({ belt: "core", tool: "todo_add", score: 184, visual: false, reason: "owner_calendar_and_hub_todo" });
    }
  }

  const activeTool = String(options.activeTool ?? "").trim();
  if (activeTool && CONTINUATION_RE.test(normalized)) {
    const activeBelt = beltsForTool(activeTool)[0];
    if (activeBelt) add({
      belt: activeBelt,
      tool: activeTool,
      score: 190,
      visual: true,
      reason: "active_visual_follow_up",
    });
  }

  // "Show/display" must never collapse to an unknown capability. The generic
  // renderer is a last resort beneath every specialised visual route.
  if (explicitVisual && ![...ranked.values()].some((candidate) => candidate.visual)) {
    add({ belt: "core", tool: "show", score: 40, visual: true, reason: "explicit_visual_fallback" });
  }

  const limit = Math.max(1, Math.min(8, Math.trunc(options.limit ?? 5)));
  const candidates = [...ranked.values()]
    .sort((left, right) => right.score - left.score || left.tool.localeCompare(right.tool))
    .slice(0, limit);
  return { candidates, explicitVisual };
}
