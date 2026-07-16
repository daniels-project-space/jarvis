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

// eBay Browse API — FREE (5,000 calls/day, no card), real UK listings with
// price/link/image. Primary shopping provider when the keyset is in the vault
// (service "ebay": EBAY_CLIENT_ID + EBAY_CLIENT_SECRET). App token cached ~2h.
let ebayTok: { value: string; until: number } | null = null;
async function ebayToken(): Promise<string> {
  if (ebayTok && ebayTok.until > Date.now()) return ebayTok.value;
  const c = await getServiceSecrets("ebay").catch(() => ({}) as Record<string, string>);
  const id = c.EBAY_CLIENT_ID ?? process.env.EBAY_CLIENT_ID;
  const secret = c.EBAY_CLIENT_SECRET ?? process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) return "";
  try {
    const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "";
    const j = await r.json();
    ebayTok = { value: j.access_token, until: Date.now() + (j.expires_in ?? 7200) * 1000 - 120_000 };
    return ebayTok.value;
  } catch {
    return "";
  }
}
async function ebayShopping(query: string): Promise<ShopResult[]> {
  const tok = await ebayToken();
  if (!tok) return [];
  try {
    const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=20&filter=buyingOptions:{FIXED_PRICE}`, {
      headers: { Authorization: `Bearer ${tok}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB" },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.itemSummaries ?? [])
      .filter((it: any) => it.price?.value && (it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl))
      .map((it: any) => ({
        title: String(it.title ?? "").slice(0, 90),
        price: `£${Number(it.price.value).toFixed(2)}`,
        priceNum: Number(it.price.value),
        source: "eBay",
        link: String(it.itemWebUrl ?? ""),
        image: String(it.image?.imageUrl ?? it.thumbnailImages?.[0]?.imageUrl ?? ""),
        rating: undefined,
        reviews: undefined,
        delivery: it.shippingOptions?.[0]?.shippingCost?.value === "0.00" ? "Free delivery" : undefined,
      }));
  } catch {
    return [];
  }
}

// Kelkoo (UK price-comparison, aggregates Amazon/John Lewis/Currys/Argos/Shein
// and dozens more retailers) read FREE + keyless through Jina's reader. This is
// the broad, sustainable default — no key, no quota, real cross-retailer prices.
async function kelkooShopping(query: string): Promise<ShopResult[]> {
  try {
    const r = await fetch(`https://r.jina.ai/https://www.kelkoo.co.uk/search?query=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Mozilla/5.0", "x-return-format": "markdown", "accept-language": "en" },
      signal: AbortSignal.timeout(16000),
    });
    if (!r.ok) return [];
    const md = await r.text();
    const out: ShopResult[] = [];
    const re = /\[([\s\S]*?)\]\((https:\/\/uk-go\.kelkoogroup\.net\/sitesearchGo[^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) && out.length < 15) {
      const blob = m[1];
      const link = m[2];
      const img = blob.match(/!\[Image \d+:[^\]]*\]\((https:\/\/r\.kelkoo\.com\/resize[^)\s]+)\)/);
      const titleM = blob.match(/Image \d+:\s*([^\]]+)\]/);
      const priceM = blob.match(/£([\d,]+\.?\d*)/);
      if (!img || !titleM || !priceM) continue;
      const seller = blob.match(/Sold by \*\*([^*]+)\*\*/);
      const free = /Free delivery/.test(blob);
      out.push({
        title: titleM[1].replace(/\s+/g, " ").trim().slice(0, 90),
        price: `£${priceM[1]}`,
        priceNum: parseFloat(priceM[1].replace(/,/g, "")) || 0,
        source: (seller ? seller[1] : "Kelkoo").trim().slice(0, 30),
        link,
        image: img[1],
        rating: undefined,
        reviews: undefined,
        delivery: free ? "Free delivery" : (blob.match(/Delivery cost: £[\d.]+/) || [undefined])[0],
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---- shopping (UK): Kelkoo (free, broad) → eBay (free) → Serper → SerpAPI ----
export async function searchShopping(query: string, gl = "uk"): Promise<ShopResult[]> {
  const k = await kelkooShopping(query);
  if (k.length >= 3) return k;
  const e = await ebayShopping(query);
  if (e.length) return [...k, ...e];
  if (k.length) return k;
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
  const serpNews = raw.map((n: any) => ({
    title: String(n.title ?? "").slice(0, 140),
    link: String(n.link ?? ""),
    source: String(n.source?.name ?? n.source ?? "").slice(0, 40),
    date: String(n.date ?? ""),
    image: String(n.thumbnail ?? ""),
  }));
  if (serpNews.length) return serpNews;
  // FREE keyless fallbacks. For the day's headlines, UK publisher feeds carry
  // real editorial photos (media:content) — a proper cinematic feed. Topic
  // searches use Google News RSS (broad, but gradient cards, no images).
  if (!query) {
    const pub = await publisherNews();
    if (pub.length >= 4) return pub;
  }
  return await googleNewsRss(query, gl);
}

// UK publisher RSS with real images (Guardian + BBC world), merged.
async function publisherNews(): Promise<NewsResult[]> {
  const feeds = [
    { url: "https://www.theguardian.com/uk/rss", source: "The Guardian" },
    { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC News" },
    { url: "https://www.theguardian.com/world/rss", source: "The Guardian" },
  ];
  const dec = (s: string) =>
    s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const all: NewsResult[] = [];
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const r = await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const xml = await r.text();
        for (const it of xml.split("<item>").slice(1, 9)) {
          const title = dec((it.match(/<title>([\s\S]*?)<\/title>/) || [, ""])[1]);
          const link = dec((it.match(/<(?:link|guid[^>]*)>([\s\S]*?)<\/(?:link|guid)>/) || [, ""])[1]);
          const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ""])[1].trim();
          // largest media:content / media:thumbnail image
          let img = "";
          let bestW = 0;
          for (const mm of it.matchAll(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"[^>]*(?:width="(\d+)")?/g)) {
            const wd = Number(mm[2] || 0);
            if (!img || wd >= bestW) {
              img = mm[1].replace(/&amp;/g, "&");
              bestW = wd;
            }
          }
          if (title && link) all.push({ title: title.slice(0, 140), link, source: f.source, date: pub ? new Date(pub).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "", image: img });
        }
      } catch {
        /* skip feed */
      }
    }),
  );
  // images first, dedupe by title
  const seen = new Set<string>();
  return all
    .filter((n) => (seen.has(n.title) ? false : (seen.add(n.title), true)))
    .sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0))
    .slice(0, 12);
}

async function googleNewsRss(query: string | null, gl = "us"): Promise<NewsResult[]> {
  const hl = gl === "uk" || gl === "gb" ? "en-GB" : "en-US";
  const geo = gl === "uk" || gl === "gb" ? "GB" : "US";
  const url = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${geo}&ceid=${geo}:en`
    : `https://news.google.com/rss?hl=${hl}&gl=${geo}&ceid=${geo}:en`;
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "en" }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return [];
    const xml = await r.text();
    const out: NewsResult[] = [];
    const items = xml.split("<item>").slice(1);
    const dec = (s: string) =>
      s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    for (const it of items.slice(0, 12)) {
      const title = dec((it.match(/<title>([\s\S]*?)<\/title>/) || [, ""])[1]);
      const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [, ""])[1].trim();
      const source = dec((it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [, ""])[1]);
      const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [, ""])[1].trim();
      if (!title || !link) continue;
      out.push({
        title: title.replace(/\s+-\s+[^-]+$/, "").slice(0, 140), // strip trailing " - Source"
        link,
        source: source.slice(0, 40),
        date: pub ? new Date(pub).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "",
        image: "",
      });
    }
    // Real article images: resolve each Google redirect and grab og:image, in
    // parallel with a tight timeout. mShots screenshots caught paywall popups;
    // og:image is the clean editorial photo. Items without one render as a
    // tasteful gradient card (FeedView fades a missing image out).
    await Promise.all(
      out.map(async (n) => {
        try {
          const pr = await fetch(n.link, { headers: { "user-agent": "Mozilla/5.0 (compatible; facebookexternalhit/1.1)" }, redirect: "follow", signal: AbortSignal.timeout(3500) });
          const html = (await pr.text()).slice(0, 60000);
          const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          if (og) n.image = og[1].replace(/&amp;/g, "&");
        } catch {
          /* no image — gradient card */
        }
      }),
    );
    return out;
  } catch {
    return [];
  }
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
  const serped = (j?.video_results ?? []).slice(0, 6).map((v: any) => ({
    id: YT(v.link ?? ""),
    title: String(v.title ?? ""),
    channel: String(v.channel?.name ?? ""),
    length: String(v.length ?? ""),
  }));
  if (serped.length) return serped;
  // Last resort: keyless YouTube scrape. YouTube redirects datacenter IPs into a
  // consent/"sorry" loop, so — exactly like ddgHtml for web — fetch the results
  // page THROUGH Jina's reader (r.jina.ai reads from its own unblocked infra).
  // x-return-format:html gives us the full page with ytInitialData to parse, so
  // video search stays alive with no provider/quota at all.
  return await ytJinaScrape(query);
}

async function ytJinaScrape(query: string): Promise<VideoResult[]> {
  try {
    const r = await fetch(`https://r.jina.ai/https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Mozilla/5.0", "x-return-format": "html", "accept-language": "en" },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]+?\});<\/script>/);
    if (!m) return [];
    const vids: VideoResult[] = [];
    const walk = (o: any) => {
      if (!o || typeof o !== "object" || vids.length >= 6) return;
      if (o.videoRenderer?.videoId) {
        const v = o.videoRenderer;
        vids.push({
          id: String(v.videoId),
          title: String(v.title?.runs?.[0]?.text ?? ""),
          channel: String(v.ownerText?.runs?.[0]?.text ?? ""),
          length: String(v.lengthText?.simpleText ?? ""),
        });
      } else for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(JSON.parse(m[1]));
    return vids;
  } catch {
    return [];
  }
}

// Which provider is live (for status/debug). Serper/SerpAPI are the keyed web
// providers, tried in that order; when neither key is present the keyless
// fallbacks (DDG for web, Kelkoo via Jina for shopping) keep search alive, so we
// report "kelkoo" as that floor rather than "none" — search is never offline.
export async function activeSearchProvider(): Promise<"serper" | "serpapi" | "kelkoo" | "none"> {
  if (await serperKey()) return "serper";
  const serp = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));
  if (serp) return "serpapi";
  return "kelkoo";
}
