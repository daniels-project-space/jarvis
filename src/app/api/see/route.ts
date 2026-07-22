import type { NextRequest } from "next/server";
import { r2Put } from "@/lib/r2";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

// Sight transport only. The frame is stored in Jarvis R2 and passed to the
// subscription Codex app-server as a real image input; Vercel never calls a
// metered vision model.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  let image = "";
  let mode = "screen";
  try {
    const body = await req.json();
    image = String(body.image ?? "");
    mode = String(body.mode ?? "screen") === "camera" ? "camera" : "screen";
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return Response.json({ error: "no image" }, { status: 400 });
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength > 12 * 1024 * 1024) return Response.json({ error: "image too large" }, { status: 413 });
  try {
    const imageUrl = await r2Put(`jarvis-${mode}`, bytes, match[1]);
    return Response.json({ imageUrl });
  } catch (error) {
    return Response.json({ error: String(error).slice(0, 200) }, { status: 502 });
  }
}
