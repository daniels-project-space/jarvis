import { auth } from "@trigger.dev/sdk/v3";
import type { NextRequest } from "next/server";
import { controlQuery } from "@/lib/control-session";
import { controlActor, controlCredentials } from "@/lib/request-auth";

export const runtime = "nodejs";

// Exchange Jarvis's existing viewer/admin capability for a short-lived token
// scoped to exactly one worker run. The Trigger project secret never reaches
// the browser, and a caller cannot subscribe to an arbitrary run id.
export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ ok: false }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const jobId = String(body?.jobId ?? "");
  if (!jobId) return Response.json({ ok: false }, { status: 400 });
  const worker: any = await controlQuery("jobs:workerRun", {
    jobId,
    ...controlCredentials(actor),
  }).catch(() => null);
  const runId = typeof worker?.runId === "string" ? worker.runId : "";
  if (!runId) return Response.json({ ok: false, pending: true }, { status: 404 });
  const accessToken = await auth.createPublicToken({
    scopes: { read: { runs: [runId] } },
    expirationTime: "1h",
  });
  return Response.json(
    { ok: true, runId, accessToken },
    { headers: { "cache-control": "private, no-store" } },
  );
}

