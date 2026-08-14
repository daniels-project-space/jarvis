const TOOL_BELT_REGISTRY = {
  core: new Set([
    "dispatch_agent", "show", "show_ranking", "rank_focus", "video_control", "hide", "web_search", "weather",
    "timer", "briefing", "remind_at", "todo_add", "todo_done", "todo_list", "calendar_view",
    "google_calendar_list", "google_calendar_create", "google_calendar_update", "google_calendar_delete",
    "open_app", "host_ui", "mac_shortcut", "current_time", "calculate", "orb_mood", "show_uploaded_image", "review_uploaded_file",
  ]),
  work: new Set([
    "orchestrate", "goal_mode", "self_repair", "self_improve", "research", "plan_my_day", "show", "net_worth", "memory_map",
    "rental_availability", "rental_stats", "rentals_calendar", "clear_chat", "new_chat", "visual_scene", "project_goal",
    "work_control", "read_url", "remember", "memory_search", "agent_status", "reminder_cancel", "todo_remove",
    "deliberate", "open_file_as_doc", "gmail_search", "gmail_read", "gmail_draft_reply",
    "gmail_list_subscriptions",
  ]),
  creative: new Set([
    "creative_sprint", "create_image", "store_image", "create_pdf", "board", "mind_map", "chart", "draft",
    "creations_list", "youtube_search", "youtube_transcript", "music_search", "visual_scene",
  ]),
  travel: new Set([
    "trip_open", "trip_plan", "trip_update", "trip_finalize", "bookings_check", "bookings_lookup", "flight_search", "open_travel_site", "places_near",
    "transport_route", "travel_map",
  ]),
  business: new Set([
    "market", "price_chart", "market_analysis", "price_watch", "price_alert", "watch_list", "watch_cancel", "shop_search", "news_today",
    "rental_availability", "rental_stats", "rentals_calendar", "net_worth", "visual_scene",
  ]),
};

export type ToolBeltName = keyof typeof TOOL_BELT_REGISTRY;

// Keep string indexing compatible with the HTTP routes while deriving every
// discoverable belt name from this single registry.
export const TOOL_BELTS: Record<string, Set<string>> & typeof TOOL_BELT_REGISTRY = TOOL_BELT_REGISTRY;
export const TOOL_BELT_NAMES = Object.freeze(
  Object.keys(TOOL_BELT_REGISTRY) as ToolBeltName[],
);

export function isToolBeltName(value: unknown): value is ToolBeltName {
  return typeof value === "string" && Object.hasOwn(TOOL_BELT_REGISTRY, value);
}

export const SUBSCRIPTION_TOOL_NAMES = new Set(
  Object.values(TOOL_BELTS).flatMap((belt) => [...belt]),
);

// These capabilities deliberately live outside the subscription-worker
// allowlist. They can be reached only through the separate foreground-owner
// endpoint, which verifies an active, authenticated chat turn for every
// discovery and invocation. Keep this finite list close to the belt registry:
// it is the complete authority surface for that endpoint.
export const FOREGROUND_OWNER_TOOL_NAMES = new Set([
  "gmail_search",
  "gmail_read",
  "gmail_draft_reply",
  "gmail_list_subscriptions",
  "google_calendar_list",
  "google_calendar_create",
  "google_calendar_update",
  "google_calendar_delete",
]);

// A subscription subprocess may propose or dispatch guarded work, but it can
// never approve its own consequential job or impersonate Daniel's decision.
for (const name of [
  "work_control",
  // Email contents and mailbox mutations remain foreground, owner-session
  // capabilities. A background subscription worker must not turn a
  // model-supplied `confirmed: true` into a real inbox action.
  "gmail_search",
  "gmail_read",
  "gmail_draft_reply",
  "gmail_list_subscriptions",
  // Uploaded files are private owner data. The foreground owner lane may show
  // a selected image; background subscription workers must never browse it.
  "show_uploaded_image",
  // Google Calendar is foreground-only. It must never become an implicit
  // side effect of a subscription worker, and its iCloud counterpart remains
  // the default calendar lane.
  "google_calendar_list",
  "google_calendar_create",
  "google_calendar_update",
  "google_calendar_delete",
]) SUBSCRIPTION_TOOL_NAMES.delete(name);
// review_uploaded_file deliberately remains subscription-routable: its
// mutation requires the exact current user-message attachment and explicit
// original-user review intent, so it cannot browse arbitrary private files.
// The subscription model already supplies the reasoning. These legacy tools
// invoke metered text models and would duplicate both latency and intelligence.
SUBSCRIPTION_TOOL_NAMES.delete("deliberate");

// Owner Gmail/Google Calendar authority is intentionally admitted from a
// small direct-command grammar, never by searching arbitrary conversation,
// pasted, quoted, or attachment text. The parser only sees the leading,
// unquoted clause of the submitted owner message.
const OWNER_REQUEST_LEAD_TERMINATOR_RE = /[\r\n\"`“”‘’]/;
const OWNER_REQUEST_QUOTED_START_RE = /^(?:[\"'`“”‘’]|>)/;
const DIRECT_GMAIL_READ_RE = /^(?:search|find|check|read|show|list|open)\b\s+(?:(?:through|in)\s+)?my\s+(?:gmail|google\s+mail|emails?|email|mailbox|inbox)\b/i;
const DIRECT_GMAIL_DRAFT_RE = /^(?:(?:draft|compose)\s+(?:an?\s+)?(?:email|gmail|google\s+mail)\b|(?:reply|respond)\s+(?:to\s+)?(?:(?:the|this|that)\s+)?(?:email|gmail|google\s+mail)\b|write\s+(?:an?\s+)?(?:email|gmail|google\s+mail)\s+(?:to|about|saying|with)\b)/i;
const DIRECT_GMAIL_DRAFT_FOLLOW_UP_RE = /\b(?:and\s+)?(?:(?:draft|compose)\s+(?:an?\s+)?(?:email|gmail|google\s+mail)\b|(?:reply|respond)\s+(?:to\s+)?(?:(?:the|this|that)\s+)?(?:email|gmail|google\s+mail)\b|write\s+(?:an?\s+)?(?:email|gmail|google\s+mail)\s+(?:to|about|saying|with)\b)/i;
const DIRECT_GMAIL_SUBSCRIPTIONS_RE = /\b(?:subscriptions?|newsletters?)\b/i;
const DIRECT_CALENDAR_LIST_RE = /^(?:(?:show|view|list|check|read|open)\b\s+|what(?:'s|\s+is)\s+on\s+)my\s+(?:google\s*)?(?:calendar|gcal|agenda|schedule)\b/i;
const DIRECT_CALENDAR_CREATE_RE = /^(?:(?:add|create|schedule|put|make|remind)\b[^\r\n\"`“”‘’]{0,160}\b(?:to|on|in)\s+my\s+(?:google\s*)?(?:calendar|gcal)\b|(?:add|create|schedule|put|make|remind)\s+(?:an?\s+)?(?:event|meeting|appointment|reminder)\b)/i;
const DIRECT_CALENDAR_UPDATE_RE = /^(?:change|edit|update|move|reschedule)\b[^\r\n\"`“”‘’]{0,160}\b(?:calendar|gcal|event|meeting|appointment|reminder)\b/i;
const DIRECT_CALENDAR_DELETE_RE = /^(?:delete|remove|cancel)\b[^\r\n\"`“”‘’]{0,160}\b(?:calendar|gcal|event|meeting|appointment|reminder)\b/i;

export function isForegroundOwnerToolName(value: unknown): value is string {
  return typeof value === "string" && FOREGROUND_OWNER_TOOL_NAMES.has(value);
}

function directOwnerRequestLead(userText: string): string {
  const candidate = String(userText ?? "").trimStart();
  if (!candidate || OWNER_REQUEST_QUOTED_START_RE.test(candidate)) return "";
  const terminator = candidate.search(OWNER_REQUEST_LEAD_TERMINATOR_RE);
  return (terminator === -1 ? candidate : candidate.slice(0, terminator))
    .slice(0, 320)
    .trimEnd();
}

function directOwnerCommand(lead: string): string {
  return lead
    .replace(/^(?:(?:hey\s+)?jarvis\s*[,:-]?\s*)?/i, "")
    .replace(/^(?:(?:can|could|would|will)\s+you\s+)?(?:please[,\s]+)?/i, "")
    .trimStart();
}

/**
 * Derive the narrow Gmail/Google Calendar scope from an explicit direct owner
 * command. This is called exactly once at message admission and the result is
 * persisted; later worker/model wording never mints or expands authority.
 */
export function foregroundOwnerToolNamesForDirectRequest(userText: string): string[] {
  const command = directOwnerCommand(directOwnerRequestLead(userText));
  if (!command) return [];

  const granted = new Set<string>();
  const gmailRead = DIRECT_GMAIL_READ_RE.test(command);
  const gmailDraft = DIRECT_GMAIL_DRAFT_RE.test(command)
    || (gmailRead && DIRECT_GMAIL_DRAFT_FOLLOW_UP_RE.test(command));
  if (gmailRead) {
    granted.add("gmail_search");
    granted.add("gmail_read");
  }
  if (gmailDraft) granted.add("gmail_draft_reply");
  if (gmailRead && DIRECT_GMAIL_SUBSCRIPTIONS_RE.test(command)) {
    granted.add("gmail_list_subscriptions");
  }

  const calendarCreate = DIRECT_CALENDAR_CREATE_RE.test(command);
  const calendarUpdate = DIRECT_CALENDAR_UPDATE_RE.test(command);
  const calendarDelete = DIRECT_CALENDAR_DELETE_RE.test(command);
  if (DIRECT_CALENDAR_LIST_RE.test(command) || calendarCreate || calendarUpdate || calendarDelete) {
    // An event lookup may be needed before any requested edit/delete, so the
    // explicitly requested Calendar action may also list the matching event.
    granted.add("google_calendar_list");
  }
  if (calendarCreate) granted.add("google_calendar_create");
  if (calendarUpdate) granted.add("google_calendar_update");
  if (calendarDelete) granted.add("google_calendar_delete");

  return [...FOREGROUND_OWNER_TOOL_NAMES].filter((toolName) => granted.has(toolName));
}

/** Backward-compatible single-tool check for the direct-command policy. */
export function foregroundOwnerToolIntentAllows(toolName: string, userText: string): boolean {
  return isForegroundOwnerToolName(toolName)
    && foregroundOwnerToolNamesForDirectRequest(userText).includes(toolName);
}

export function slimToolDefinition<T extends { description?: string }>(tool: T): T {
  const description = String(tool.description ?? "");
  let cut = description.indexOf(". ");
  if (cut !== -1 && cut < 60) {
    const second = description.indexOf(". ", cut + 2);
    if (second !== -1) cut = second;
  }
  const short = cut === -1 ? description.slice(0, 240) : description.slice(0, Math.min(cut + 1, 300));
  return { ...tool, description: short };
}
