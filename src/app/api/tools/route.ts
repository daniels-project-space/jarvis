import type { NextRequest } from "next/server";
import { reportIncident } from "@/lib/context";
import { TOOL_DEFS, executeTool } from "@/lib/tools";

// The realtime client fetches tool definitions here to register them on the
// session. ?live=1 returns a SLIMMED belt: paragraph-long descriptions and
// background-ops tools made every voice turn reprocess a huge prompt — that
// was most of live mode's response lag.
// Realtime starts with a compact core belt, then loads a domain belt only when
// the conversation enters work, creative, travel or business territory. This
// keeps every ordinary voice turn from reconsidering ~70 JSON schemas.
const LIVE_BELTS: Record<string, Set<string>> = {
  core: new Set([
    "dispatch_agent", "work_control", "show", "show_ranking", "rank_focus", "video_control", "hide",
    "web_search", "read_url", "remember", "memory_search", "agent_status", "weather", "timer", "briefing",
    "remind_at", "reminder_cancel", "todo_add", "todo_done", "todo_remove", "todo_list", "calendar_add",
    "calendar_remove", "calendar_view", "open_app", "deliberate", "current_time", "calculate",
  ]),
  work: new Set([
    "orchestrate", "self_repair", "self_improve", "research", "plan_my_day", "net_worth", "memory_map",
    "rental_availability", "rental_stats", "rentals_calendar", "clear_chat", "new_chat",
  ]),
  creative: new Set([
    "creative_sprint", "create_image", "store_image", "create_pdf", "board", "mind_map", "chart", "draft",
    "creations_list", "youtube_search", "youtube_transcript", "music_search",
  ]),
  travel: new Set([
    "trip_open", "trip_plan", "trip_update", "trip_finalize", "flight_search", "open_travel_site", "places_near",
    "transport_route",
  ]),
  business: new Set([
    "market", "price_chart", "market_analysis", "price_watch", "watch_cancel", "shop_search", "news_today",
    "rental_availability", "rental_stats", "rentals_calendar", "net_worth",
  ]),
};
export async function GET(req: NextRequest) {
  const live = new URL(req.url).searchParams.get("live");
  if (live) {
    const belt = LIVE_BELTS[live === "1" ? "core" : live] ?? LIVE_BELTS.core;
    const slim = TOOL_DEFS.filter((t) => belt.has(t.name)).map((t) => {
      // first sentence (or two, if the first is very short) carries the intent;
      // the persona carries the routing rules
      const d = String(t.description ?? "");
      let cut = d.indexOf(". ");
      if (cut !== -1 && cut < 60) {
        const second = d.indexOf(". ", cut + 2);
        if (second !== -1) cut = second;
      }
      const short = cut === -1 ? d.slice(0, 240) : d.slice(0, Math.min(cut + 1, 300));
      return { ...t, description: short };
    });
    return Response.json(slim);
  }
  return Response.json(TOOL_DEFS);
}

// Tool bridge for the realtime voice session: the browser receives function
// calls from OpenAI Realtime and executes them here.
export const runtime = "nodejs";
export const maxDuration = 120; // market_analysis / trip scouts can run 60-90s

export async function POST(req: NextRequest) {
  let toolName = "unknown";
  try {
    const { name, args } = await req.json();
    toolName = String(name);
    const result = await executeTool(toolName, args ?? {});
    return Response.json({ result });
  } catch (e: any) {
    await reportIncident("api/tools", `tool:${toolName}:${String(e?.message ?? e).slice(0, 60)}`, `Tool ${toolName} crashed: ${e?.message ?? e}`);
    return Response.json({ result: `Tool failed: ${e?.message ?? e}` }, { status: 200 });
  }
}
