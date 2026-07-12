import type { NextRequest } from "next/server";
import { reportIncident } from "@/lib/context";
import { TOOL_DEFS, executeTool } from "@/lib/tools";

// The realtime client fetches tool definitions here to register them on the
// session. ?live=1 returns a SLIMMED belt: paragraph-long descriptions and
// background-ops tools made every voice turn reprocess a huge prompt — that
// was most of live mode's response lag.
const LIVE_EXCLUDE = new Set(["self_repair", "self_improve", "deliberate", "memory_map"]);
export async function GET(req: NextRequest) {
  if (new URL(req.url).searchParams.get("live")) {
    const slim = TOOL_DEFS.filter((t) => !LIVE_EXCLUDE.has(t.name)).map((t) => {
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
