import { timingSafeEqual } from "node:crypto";
import { tasks } from "@trigger.dev/sdk/v3";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const expected = Buffer.from(process.env.JARVIS_WORKER_TOKEN ?? "");
  const supplied = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.chat !== "boolean" || typeof body.fleet !== "boolean"
    || !Number.isSafeInteger(body.at) || Math.abs(Date.now() - body.at) > 5 * 60_000) {
    return Response.json({ error: "invalid recovery wake" }, { status: 400 });
  }
  const bucket = Math.floor(body.at / 60_000);
  const handles = await Promise.all([
    ...(body.chat ? ["jarvis-chat-dispatcher"] : []),
    ...(body.fleet ? ["jarvis-agent-fleet-supervisor"] : []),
  ].map(id => tasks.trigger(id, {}, { idempotencyKey: `activity-recovery-${id}-${bucket}` })));
  return Response.json({ dispatched: handles.length });
}
