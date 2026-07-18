import type { NextRequest } from "next/server";
import { convexMutation, convexQuery } from "@/lib/context";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";
import { withAdminSession } from "@/lib/control-context";
import { distillFinding } from "@/lib/finding-distill";

// Popup-card shaping is deterministic because the background Codex worker has
// already reviewed and summarized the finding. Results are cached once on the
// row; no second inference provider or extra model latency is involved.
export const runtime = "nodejs";
export const maxDuration = 30;

async function handlePost(req: NextRequest) {
  let id = "";
  try {
    id = String((await req.json()).id ?? "");
  } catch {
    /* fall through */
  }
  if (!id) return Response.json({ error: "no id" }, { status: 400 });

  const f: any = await convexQuery("findings:get", { id }).catch(() => null);
  if (!f) return Response.json({ error: "not found" }, { status: 404 });
  if (f.important !== undefined) return Response.json({ important: f.important, bullets: f.bullets ?? [] });

  const { important, bullets } = distillFinding(f);
  await convexMutation("findings:distill", { id, bullets, important }).catch(() => {});
  return Response.json({ important, bullets });
}

export async function POST(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return withAdminSession(authTokenHash, () => handlePost(req));
}
