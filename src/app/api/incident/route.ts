import type { NextRequest } from "next/server";
import { reportIncident } from "@/lib/context";

// Client-side error reporting → self-healing pipeline. The UI posts uncaught
// errors/rejections here (deduped per session client-side).
export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  try {
    const { signature, message } = await req.json();
    if (!signature || !message) return Response.json({ ok: false });
    await reportIncident("client", String(signature).slice(0, 200), String(message).slice(0, 1500));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false });
  }
}
