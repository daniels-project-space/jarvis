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
