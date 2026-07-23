import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { executeTool, TOOL_DEFS } from "@/lib/tools";
import { reportIncident } from "@/lib/context";
import { SUBSCRIPTION_TOOL_NAMES, TOOL_BELTS, slimToolDefinition } from "@/lib/tool-belts";
import { normalizeToolInvocationContext } from "@/lib/tool-invocation-context";

export const runtime = "nodejs";
export const maxDuration = 120;

function authorized(req: NextRequest): boolean {
  const expected = process.env.JARVIS_DISPATCH_TOKEN ?? "";
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const requested = new URL(req.url).searchParams.get("belt") ?? "core";
  const belt = Object.hasOwn(TOOL_BELTS, requested) ? TOOL_BELTS[requested] : TOOL_BELTS.core;
  return Response.json(
    TOOL_DEFS.filter((tool) => belt.has(tool.name) && SUBSCRIPTION_TOOL_NAMES.has(tool.name)).map(slimToolDefinition),
  );
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let name = "unknown";
  try {
    const body = await req.json();
    name = String(body?.name ?? "");
    if (!SUBSCRIPTION_TOOL_NAMES.has(name)) {
      return Response.json({ result: "Tool unavailable to subscription conversation workers." }, { status: 403 });
    }
    const invocationContext = normalizeToolInvocationContext(body?.invocationContext, {
      allowUserMessageId: true,
    });
    return Response.json({
      result: await executeTool(
        name,
        { ...(body?.args ?? {}), _subscription_reasoner: true },
        { invocationContext },
      ),
    });
  } catch (error: any) {
    await reportIncident("api/agent-tool", `agent-tool:${name}:${String(error?.message ?? error).slice(0, 60)}`, String(error?.message ?? error));
    return Response.json({ result: `Tool failed: ${error?.message ?? error}` });
  }
}
