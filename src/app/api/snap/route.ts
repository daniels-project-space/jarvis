import type { NextRequest } from "next/server";

// Full-page website screenshots for the "site" viewport — most sites block
// iframes (X-Frame-Options / frame-ancestors), so JARVIS shows a scrollable
// screenshot that looks embedded instead. Providers: thum.io, then WordPress
// mshots (both keyless).
export const runtime = "nodejs";
export const maxDuration = 60;

async function fetchImage(url: string, timeoutMs: number): Promise<ArrayBuffer | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126" },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = await r.arrayBuffer();
    // mshots serves a tiny "generating" placeholder gif at first — reject it
    if (buf.byteLength < 12_000) return null;
    return buf;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") ?? "";
  if (!/^https?:\/\//i.test(url)) return new Response("bad url", { status: 400 });

  let buf = await fetchImage(`https://image.thum.io/get/fullpage/width/1280/${url}`, 25_000);
  if (!buf) {
    const ms = `https://s0.wp.com/mshots/v1/${encodeURIComponent(url)}?w=1280&vpw=1280&vph=960`;
    for (let i = 0; i < 3 && !buf; i++) {
      buf = await fetchImage(ms, 12_000);
      if (!buf) await sleep(2500); // mshots renders async — give it a moment
    }
  }
  if (!buf) {
    // last resort: microlink free tier (JSON envelope around a screenshot URL)
    try {
      const j: any = await (
        await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false`)
      ).json();
      const shot = j?.data?.screenshot?.url;
      if (shot) buf = await fetchImage(shot, 15_000);
    } catch {
      /* out of providers */
    }
  }
  if (!buf) return new Response("snapshot unavailable", { status: 502 });
  return new Response(buf, {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=1800" },
  });
}
