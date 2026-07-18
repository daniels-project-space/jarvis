import type { NextRequest } from "next/server";
import { reportIncident } from "@/lib/context";
import { actorAdminHash, controlActor } from "@/lib/request-auth";
import { TOOL_DEFS, executeTool } from "@/lib/tools";
import { TOOL_BELTS, slimToolDefinition } from "@/lib/tool-belts";

// The realtime client fetches tool definitions here to register them on the
// session. ?live=1 returns a SLIMMED belt: paragraph-long descriptions and
// background-ops tools made every voice turn reprocess a huge prompt — that
// was most of live mode's response lag.
// Realtime starts with a compact core belt, then loads a domain belt only when
// the conversation enters work, creative, travel or business territory. This
// keeps every ordinary voice turn from reconsidering ~70 JSON schemas.
export async function GET(req: NextRequest) {
  const live = new URL(req.url).searchParams.get("live");
  if (live) {
    const belt = TOOL_BELTS[live === "1" ? "core" : live] ?? TOOL_BELTS.core;
    const slim = TOOL_DEFS.filter((t) => belt.has(t.name)).map(slimToolDefinition);
    return Response.json(slim);
  }
  return Response.json(TOOL_DEFS);
}

// Tool bridge for the realtime voice session: the browser receives function
// calls from the subscription CLI/tool bridge and executes them here.
export const runtime = "nodejs";
export const maxDuration = 120; // market_analysis / trip scouts can run 60-90s

export async function POST(req: NextRequest) {
  let toolName = "unknown";
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  const authTokenHash = actorAdminHash(actor);
  try {
    const { name, args } = await req.json();
    toolName = String(name);
    const result = await executeTool(toolName, args ?? {}, authTokenHash);
    return Response.json({ result });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await reportIncident("api/tools", `tool:${toolName}:${message.slice(0, 60)}`, `Tool ${toolName} crashed: ${message}`, undefined, authTokenHash);
    return Response.json({ result: `Tool failed: ${message}` }, { status: 200 });
  }
}
