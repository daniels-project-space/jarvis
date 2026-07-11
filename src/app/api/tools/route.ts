import type { NextRequest } from "next/server";
import { TOOL_DEFS, executeTool } from "@/lib/tools";

// The realtime client fetches tool definitions here to register them on the session.
export async function GET() {
  return Response.json(TOOL_DEFS);
}

// Tool bridge for the realtime voice session: the browser receives function
// calls from OpenAI Realtime and executes them here.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    const result = await executeTool(String(name), args ?? {});
    return Response.json({ result });
  } catch (e: any) {
    return Response.json({ result: `Tool failed: ${e?.message ?? e}` }, { status: 200 });
  }
}
