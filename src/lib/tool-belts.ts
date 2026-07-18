export const TOOL_BELTS: Record<string, Set<string>> = {
  core: new Set([
    "dispatch_agent", "show", "show_ranking", "rank_focus", "video_control", "hide", "web_search", "weather",
    "timer", "briefing", "remind_at", "todo_add", "todo_done", "todo_list", "calendar_add", "calendar_view",
    "open_app", "mac_shortcut", "current_time", "calculate", "orb_mood",
  ]),
  work: new Set([
    "orchestrate", "self_repair", "self_improve", "research", "plan_my_day", "net_worth", "memory_map",
    "rental_availability", "rental_stats", "rentals_calendar", "clear_chat", "new_chat", "visual_scene", "project_goal",
    "work_control", "read_url", "remember", "memory_search", "agent_status", "reminder_cancel", "todo_remove",
    "calendar_remove", "deliberate",
  ]),
  creative: new Set([
    "creative_sprint", "create_image", "store_image", "create_pdf", "board", "mind_map", "chart", "draft",
    "creations_list", "youtube_search", "youtube_transcript", "music_search", "visual_scene",
  ]),
  travel: new Set([
    "trip_open", "trip_plan", "trip_update", "trip_finalize", "flight_search", "open_travel_site", "places_near",
    "transport_route",
  ]),
  business: new Set([
    "market", "price_chart", "market_analysis", "price_watch", "price_alert", "watch_list", "watch_cancel", "shop_search", "news_today",
    "rental_availability", "rental_stats", "rentals_calendar", "net_worth", "visual_scene",
  ]),
};

export const SUBSCRIPTION_TOOL_NAMES = new Set(
  Object.values(TOOL_BELTS).flatMap((belt) => [...belt]),
);

// A subscription subprocess may propose or dispatch guarded work, but it can
// never approve its own consequential job or impersonate Daniel's decision.
SUBSCRIPTION_TOOL_NAMES.delete("work_control");
// The subscription model already supplies the reasoning. These legacy tools
// invoke metered text models and would duplicate both latency and intelligence.
SUBSCRIPTION_TOOL_NAMES.delete("deliberate");
SUBSCRIPTION_TOOL_NAMES.delete("plan_my_day");

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
