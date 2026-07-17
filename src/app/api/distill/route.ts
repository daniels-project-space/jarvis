import type { NextRequest } from "next/server";
import { convexMutation, convexQuery } from "@/lib/context";
import { getSecret } from "@/lib/vault";
import { adminSessionHash, validateAdminSession } from "@/lib/control-session";
import { withAdminSession } from "@/lib/control-context";

// Popup-card intelligence: each background finding gets screened (is this
// worth Daniel's attention at all?) and compressed into a few crisp bullets.
// Results are cached onto the findings row, so this runs once per finding.
export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM = `You screen and compress background-agent reports for popup cards on Daniel's JARVIS dashboard. Return ONLY JSON: {"important": boolean, "bullets": string[]}.

important=false for: internal plumbing (self-repairs, validator/schema/tooling fixes, dev-infra chatter, test runs), routine confirmations, progress notes, anything Daniel wouldn't act on or genuinely want interrupted for.
important=true for: things he explicitly asked for, money/business/rentals/customers, blockers that need HIS decision, finished deliverables he's waiting on.

bullets: 3-5 points, each under 14 words, plain human language, keep concrete numbers/names/links, no jargon, no preamble.`;

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

  const key = process.env.GROQ_API_KEY ?? (await getSecret("groq", "GROQ_API_KEY").catch(() => ""));
  let important = true;
  let bullets: string[] = [f.spoken].filter(Boolean);
  if (key) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: 400,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `Task: ${f.source}\nHeadline: ${f.spoken}\nFull report:\n${String(f.detail).slice(0, 6000)}` },
          ],
        }),
      });
      const j = await r.json();
      const out = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
      if (typeof out.important === "boolean") important = out.important;
      if (Array.isArray(out.bullets) && out.bullets.length) bullets = out.bullets.map((b: any) => String(b).slice(0, 140)).slice(0, 6);
    } catch {
      /* fail open: important stays true with the headline as the bullet */
    }
  }
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
