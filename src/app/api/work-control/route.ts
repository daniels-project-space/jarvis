import type { NextRequest } from "next/server";
import { adminSessionHash, controlMutation, validateAdminSession } from "@/lib/control-session";

const ACTIONS = new Set(["approve", "decline", "pause", "resume", "cancel", "retry", "answer"]);

export async function POST(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!(await validateAdminSession(authTokenHash))) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const jobId = String(body?.jobId ?? "");
  const action = String(body?.action ?? "");
  if (!jobId || !ACTIONS.has(action)) return Response.json({ ok: false }, { status: 400 });

  let ok: unknown = false;
  if (action === "approve" || action === "decline") {
    ok = await controlMutation("approvals:decide", {
      jobId,
      decision: action === "approve" ? "approved" : "declined",
      authTokenHash,
    });
  } else if (action === "answer") {
    const answer = String(body?.input ?? "").trim();
    if (!answer) return Response.json({ ok: false }, { status: 400 });
    ok = await controlMutation("jobs:provideInput", { jobId, answer, authTokenHash });
  } else {
    ok = await controlMutation("jobs:control", { jobId, action, authTokenHash });
  }
  return Response.json({ ok: ok === true }, { status: ok === true ? 200 : 409 });
}
