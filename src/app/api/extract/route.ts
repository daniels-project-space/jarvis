import type { NextRequest } from "next/server";
import { extractMemory } from "@/lib/extract";
import { getSecret } from "@/lib/vault";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";
import { withAdminSession } from "@/lib/control-context";

// Memory capture for live-voice turns (the UI posts each finished exchange).
export const runtime = "nodejs";
export const maxDuration = 30;

async function handlePost(req: NextRequest) {
  try {
    const { user, assistant } = await req.json();
    if (!user || !assistant) return Response.json({ saved: 0 });
    const key = process.env.GROQ_API_KEY ?? (await getSecret("groq", "GROQ_API_KEY").catch(() => ""));
    if (!key) return Response.json({ saved: 0 });
    const saved = await extractMemory(key, String(user).slice(0, 2000), String(assistant).slice(0, 2000));
    return Response.json({ saved });
  } catch {
    return Response.json({ saved: 0 });
  }
}

export async function POST(req: NextRequest) {
  const authTokenHash = await adminSessionHash(req);
  if (!authTokenHash || !(await validateAdminSession(authTokenHash))) {
    return Response.json({ saved: 0 }, { status: 401 });
  }
  return withAdminSession(authTokenHash, () => handlePost(req));
}
