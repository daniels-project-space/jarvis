import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { privateCaptureObjectKey, privateR2Put } from "@/lib/private-r2";
import { controlActor, isOwnerActor } from "@/lib/request-auth";

// Sight transport only. The frame goes to private R2 and the opaque capture
// id is passed to the subscription worker as a real image input; Vercel never
// calls a metered vision model or returns a public asset URL.
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  let image = "";
  try {
    const body = await req.json();
    image = String(body.image ?? "");
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return Response.json({ error: "no image" }, { status: 400 });
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.byteLength > 12 * 1024 * 1024) return Response.json({ error: "image too large" }, { status: 413 });
  try {
    const captureId = randomUUID();
    await privateR2Put(privateCaptureObjectKey(captureId), bytes, match[1]);
    return Response.json({ captureId });
  } catch (error) {
    return Response.json({ error: String(error).slice(0, 200) }, { status: 502 });
  }
}
