import type { NextRequest } from "next/server";
import { getSecret } from "@/lib/vault";

// Screen sight (mined from ethanplusai/jarvis's screen.py, web-adapted): the
// client captures one frame of a shared screen/window and this route turns it
// into a dense text description the brain can act on.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return Response.json({ error: "no vision key" }, { status: 500 });
  let image = "";
  let question = "";
  try {
    const b = await req.json();
    image = String(b.image ?? ""); // data:image/jpeg;base64,...
    question = String(b.question ?? "").slice(0, 400);
    var mode = String(b.mode ?? "screen");
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!image.startsWith("data:image/")) return Response.json({ error: "no image" }, { status: 400 });

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                mode === "camera"
                  ? "Daniel just pointed his camera at something in the real world. Identify it and read ALL legible text verbatim (labels, documents, signs, screens, packaging, handwriting, serial/model numbers, prices). " +
                    "Then say concisely what it is and anything useful about it. " +
                    (question ? `He asked: "${question}" — focus on that.` : "") +
                    " Under 180 words, no preamble."
                  : "This is Daniel's shared screen. Describe what's on it densely and usefully for an assistant about to help him: " +
                    "the app/site, the specific content (titles, code, errors, numbers, form fields), and anything that looks like the thing he needs help with. " +
                    (question ? `He asked: "${question}" — focus on what's relevant to that.` : "") +
                    " Under 180 words, no preamble.",
            },
            { type: "image_url", image_url: { url: image, detail: "high" } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) return Response.json({ error: `vision ${r.status}` }, { status: 502 });
  const j: any = await r.json();
  const description = String(j.choices?.[0]?.message?.content ?? "").trim();
  return Response.json({ description });
}
