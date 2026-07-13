import "server-only";
import { getSecret, getServiceSecrets } from "./vault";

// Unified search layer. Primary provider is Serper.dev (google.serper.dev) —
// 2,500 free credits on signup then ~$0.30–1.00 / 1,000 searches, roughly an
// order of magnitude cheaper than SerpAPI, same Google data. SerpAPI stays as
// an automatic fallback (and still owns flights, which Serper doesn't do).
//
// Add the key to the vault as service "serper", key SERPER_API_KEY, and every
// call site below switches over with zero further changes.

type WebResult = { title: string; link: string; snippet: string };
type WebOut = { answer?: string; results: WebResult[] } | null;
export type ShopResult = {
  title: string;
  price: string;
  priceNum: number;
  source: string;
  link: string;
  image: string;
  rating?: number;
  reviews?: number;
  delivery?: string;
};
type NewsResult = { title: string; link: string; source: string; date: string; image: string };
type VideoResult = { id: string; title: string; channel: string; length: string };

const YT = (s: string) => {
  const m = String(s).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/) ?? String(s).match(/^([\w-]{11})$/);
  return m ? m[1] : "";
};
function priceNum(p: any): number {
  const n = parseFloat(String(p ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function serperKey(): Promise<string> {
  return process.env.SERPER_API_KEY ?? (await getServiceSecrets("serper").then((s) => s.SERPER_API_KEY ?? "").catch(() => ""));
}
async function serper(path: string, body: Record<string, unknown>): Promise<any | null> {
  const key = await serperKey();
  if (!key) return null;
  try {
    const r = await fetch(`https://google.serper.dev/${path}`, {
      method: "POST",
      headers: { "X-API-KEY": key, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
async function serpapi(params: Record<string, string>): Promise<any | null> {
  const key = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));
  if (!key) return null;
  try {
    const qs = new URLSearchParams({ ...params, api_key: key });
    const r = await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    // SerpAPI signals "out of searches" / other faults as a 200 with an error
    // body — treat that as a hard failure so callers fall through to the next
    // provider (this is exactly why the DDG fallback wasn't triggering).
    if (j?.error) return null;
    return j;
  } catch {
    return null;
  }
}

// ---- web ----
export async function searchWeb(query: string, num = 8, gl = "us"): Promise<WebOut> {
  const s = await serper("search", { q: query, num, gl: gl === "uk" ? "gb" : gl });
  if (s?.organic) {
    return {
      answer: s.answerBox?.answer ?? s.answerBox?.snippet ?? s.knowledgeGraph?.description,
      results: (s.organic as any[]).slice(0, num).map((r) => ({ title: String(r.title ?? ""), link: String(r.link ?? ""), snippet: String(r.snippet ?? "") })),
    };
  }
  const j = await serpapi({ engine: "google", q: query, num: String(num) });
  const organic = (j?.organic_results ?? []).slice(0, num);
  if (organic.length) {
    return {
      answer: j.answer_box?.answer ?? j.answer_box?.snippet,
      results: organic.map((r: any) => ({ title: String(r.title ?? ""), link: String(r.link ?? ""), snippet: String(r.snippet ?? "") })),
    };
  }
  // Last resort: keyless DuckDuckGo HTML scrape — keeps general search alive
  // with no provider/quota at all (shopping/news still need a real provider).
  return await ddgHtml(query, num);
}

// Keyless web search that works from serverless: DuckDuckGo blocks datacenter
// IPs directly, so we fetch its results page THROUGH Jina's reader (r.jina.ai
// fetches from its own infra, unblocked, and returns markdown). We parse the
// "## [title](ddg-redirect)" result headings and decode the real target,
// skipping sponsored (Bing/y.js) links.
async function ddgHtml(query: string, num: number): Promise<WebOut> {
  try {
    const r = await fetch(`https://r.jina.ai/https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Mozilla/5.0", "x-return-format": "markdown", "accept-language": "en" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const md = await r.text();
    const results: WebResult[] = [];
    const seen = new Set<string>();
    const re = /#{2,3}\s+\[([^\]]+)\]\((https:\/\/duckduckgo\.com\/l\/\?uddg=[^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) && results.length < num) {
      const enc = m[2].match(/uddg=([^&]+)/);
      if (!enc) continue;
      let link: string;
      try {
        link = decodeURIComponent(enc[1]);
      } catch {
        continue;
      }
      if (/duckduckgo\.com\/y\.js|ad_domain=|bing\.com\/aclick/i.test(link)) continue; // ads
      if (seen.has(link)) continue;
      seen.add(link);
      const title = m[1].replace(/\*+/g, " ").replace(/\s+/g, " ").trim();
      // snippet: the longest bracketed text between this heading and the next
      const block = md.slice(m.index, md.indexOf("\n## ", m.index + 3) === -1 ? undefined : md.indexOf("\n## ", m.index + 3));
      let snippet = "";
      for (const sm of block.matchAll(/\[([^\]]{25,300})\]\(https:\/\/duckduckgo\.com\/l\//g)) {
        const t = sm[1].replace(/\*+/g, " ").replace(/!\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
        if (t.length > snippet.length && t !== title) snippet = t;
      }
      results.push({ title, link, snippet: snippet.slice(0, 300) });
    }
    return results.length ? { results } : null;
  } catch {
    return null;
  }
}

// ---- shopping (UK) ----
export async function searchShopping(query: string, gl = "uk"): Promise<ShopResult[]> {
  const s = await serper("shopping", { q: query, gl: gl === "uk" ? "gb" : gl, hl: "en" });
  if (s?.shopping) {
    return (s.shopping as any[])
      .filter((r) => r.imageUrl && (r.price || r.priceValue))
      .map((r) => ({
        title: String(r.title ?? "").slice(0, 90),
        price: String(r.price ?? `£${r.priceValue}`).slice(0, 14),
        priceNum: r.priceValue != null ? Number(r.priceValue) : priceNum(r.price),
        source: String(r.source ?? "").slice(0, 30),
        link: String(r.link ?? ""),
        image: String(r.imageUrl ?? ""),
        rating: r.rating != null ? Number(r.rating) : undefined,
        reviews: r.ratingCount != null ? Number(r.ratingCount) : undefined,
        delivery: r.delivery ? String(r.delivery).slice(0, 40) : undefined,
      }));
  }
  const j = await serpapi({ engine: "google_shopping", q: query, gl, hl: "en", num: "20" });
  if (j?.error || !j) return [];
  return (j.shopping_results ?? [])
    .filter((r: any) => r.thumbnail && r.extracted_price)
    .map((r: any) => ({
      title: String(r.title ?? "").slice(0, 90),
      price: String(r.price ?? `£${r.extracted_price}`).slice(0, 14),
      priceNum: Number(r.extracted_price),
      source: String(r.source ?? "").slice(0, 30),
      link: String(r.product_link ?? r.link ?? ""),
      image: String(r.thumbnail ?? ""),
      rating: r.rating != null ? Number(r.rating) : undefined,
      reviews: r.reviews != null ? Number(r.reviews) : undefined,
      delivery: r.delivery ? String(r.delivery).slice(0, 40) : undefined,
    }));
}

// ---- news ----
export async function searchNews(query: string | null, gl = "us"): Promise<NewsResult[]> {
  const q = query || "top stories";
  const s = await serper("news", { q, gl: gl === "uk" ? "gb" : gl, hl: "en" });
  if (s?.news) {
    return (s.news as any[]).map((n) => ({
      title: String(n.title ?? "").slice(0, 140),
      link: String(n.link ?? ""),
      source: String(n.source ?? "").slice(0, 40),
      date: String(n.date ?? ""),
      image: String(n.imageUrl ?? ""),
    }));
  }
  const params: Record<string, string> = { engine: "google_news", gl, hl: "en" };
  if (query) params.q = query;
  else params.topic_token = "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB";
  const j = await serpapi(params);
  const raw: any[] = (j?.news_results ?? []).flatMap((n: any) => (n.stories ? n.stories : [n]));
  return raw.map((n: any) => ({
    title: String(n.title ?? "").slice(0, 140),
    link: String(n.link ?? ""),
    source: String(n.source?.name ?? n.source ?? "").slice(0, 40),
    date: String(n.date ?? ""),
    image: String(n.thumbnail ?? ""),
  }));
}

// ---- videos (youtube-first) ----
export async function searchVideos(query: string): Promise<VideoResult[]> {
  const s = await serper("videos", { q: `${query} youtube`, gl: "us" });
  if (s?.videos) {
    return (s.videos as any[])
      .map((v) => ({ id: YT(v.link ?? ""), title: String(v.title ?? ""), channel: String(v.channel ?? v.source ?? ""), length: String(v.duration ?? "") }))
      .filter((v) => v.id)
      .slice(0, 6);
  }
  const j = await serpapi({ engine: "youtube", search_query: query });
  return (j?.video_results ?? []).slice(0, 6).map((v: any) => ({
    id: YT(v.link ?? ""),
    title: String(v.title ?? ""),
    channel: String(v.channel?.name ?? ""),
    length: String(v.length ?? ""),
  }));
}

// Which provider is live (for status/debug).
export async function activeSearchProvider(): Promise<"serper" | "serpapi" | "none"> {
  if (await serperKey()) return "serper";
  const sk = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));
  return sk ? "serpapi" : "none";
}
