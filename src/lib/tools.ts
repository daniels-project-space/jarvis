import "server-only";
import { convexMutation, convexQuery } from "./context";
import { getSecret } from "./vault";

// JARVIS's tool belt — one definition list (OpenAI function schema) executed
// server-side by /api/chat (Groq loop) and /api/tools (realtime client bridge).

export const TOOL_DEFS = [
  {
    name: "dispatch_agent",
    description:
      "Launch a background Claude Code agent for work that genuinely needs minutes: deep research across sources, fixing or building something in a repo, digging through code. It has web access, all of Daniel's repos, and the secrets vault. Returns immediately; the result gets woven into conversation when ready (a few minutes). Do NOT dispatch for quick lookups you can do yourself right now (youtube_search, youtube_transcript, web_search, read_url), and never re-dispatch a topic a fresh agent finding already covers.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear, self-contained task including all context the agent needs (URLs, video IDs, what to find out)" },
        repo: { type: "string", description: "owner/repo or short name if the task is about a specific repo, else omit" },
        model: { type: "string", enum: ["haiku", "sonnet", "opus"], description: "sonnet for research/summaries/normal code (DEFAULT — fast), opus ONLY for hard multi-file engineering, haiku for trivial lookups" },
        mcp: { type: "array", items: { type: "string", enum: ["playwright", "context7"] }, description: "Optional MCP servers: playwright for live browser automation, context7 for library docs" },
      },
      required: ["task"],
    },
  },
  {
    name: "show",
    description:
      "Put something on Daniel's screen while you talk: a webpage, YouTube video, image, code, or notes. Use this for ANYTHING visual or detailed instead of reading it out.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["url", "video", "image", "code", "markdown"] },
        value: { type: "string", description: "url / YouTube link or ID / image url / code text / markdown text" },
        title: { type: "string", description: "Short label shown above the panel" },
      },
      required: ["kind", "value"],
    },
  },
  { name: "hide", description: "Clear the screen panel.", parameters: { type: "object", properties: {} } },
  {
    name: "web_search",
    description:
      "Fast web search — the full result list automatically appears on Daniel's screen; you speak the one-line takeaway. Use this (not dispatch_agent) for anything findable in one search: prices, hotels, news, facts.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "flight_search",
    description:
      "Live flight search (Google Flights) — full results with prices/times appear on Daniel's screen instantly; speak only the best option. Use this for ANY flight question, never dispatch_agent.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "departure IATA airport code, e.g. LHR or LON" },
        to: { type: "string", description: "arrival IATA code, e.g. DPS for Bali" },
        depart_date: { type: "string", description: "YYYY-MM-DD" },
        return_date: { type: "string", description: "YYYY-MM-DD, omit for one-way" },
      },
      required: ["from", "to", "depart_date"],
    },
  },
  {
    name: "youtube_search",
    description: "Find YouTube videos by description/topic — returns titles, channels, links, video IDs.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "youtube_transcript",
    description: "Fetch the transcript of a YouTube video (its content, so you can discuss it). Pass a URL or video ID.",
    parameters: { type: "object", properties: { video: { type: "string" } }, required: ["video"] },
  },
  {
    name: "read_url",
    description: "Read a webpage as plain text.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "remember",
    description: "Save a durable fact/preference/decision to long-term memory.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fact", "preference", "decision", "project", "task"] },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "title", "body"],
    },
  },
  {
    name: "memory_search",
    description: "Search long-term memory.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "agent_status",
    description: "What background agents are doing right now + latest findings.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "rentals_calendar",
    description:
      "Daniel's ACTUAL rental calendar from the rental manager: what's out, being picked up, or returned on each day. Use for any question about rentals/bookings/schedule. Shows the full calendar on screen; speak the short answer.",
    parameters: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD, default today" },
        days: { type: "number", description: "how many days ahead, default 7, max 30" },
      },
    },
  },
  {
    name: "weather",
    description: "Current weather + 5-day forecast, shown as a visual widget on Daniel's screen. Use for any weather question.",
    parameters: {
      type: "object",
      properties: { location: { type: "string", description: "city/place, default London" } },
    },
  },
  {
    name: "clear_chat",
    description: "Wipe the current chat's history. Use when Daniel asks to clear/delete the chat — this IS the action, never dispatch an agent for it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "new_chat",
    description: "Open a fresh chat thread (old one stays in history). Use when Daniel asks for a new chat/conversation.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "current_time",
    description: "The current date and time in Daniel's timezone (Europe/London). Use whenever you need to know the date, day of week, or time right now.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "self_repair",
    description:
      "Something is BROKEN (in JARVIS itself or any of Daniel's apps): file it and dispatch a repair engineer immediately to reproduce it, trace the root cause and fix it. Use whenever Daniel reports a malfunction or you notice a tool/feature failing repeatedly. Tell him one casual line that you're on it.",
    parameters: {
      type: "object",
      properties: {
        problem: { type: "string", description: "What's broken, with every detail Daniel gave (exact behaviour, when it happens)" },
        app: { type: "string", description: "Affected app/repo if it's not JARVIS itself (e.g. music-house)" },
      },
      required: ["problem"],
    },
  },
  {
    name: "self_improve",
    description:
      "Upgrade JARVIS himself: add a new tool/capability, improve the UI or design, extend behaviour. Dispatches an engineer on the jarvis repo; validated changes go live automatically within ~5 minutes. Use when Daniel asks for an ability you don't have, or you keep missing one.",
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: "The capability or improvement, specific and self-contained" },
      },
      required: ["request"],
    },
  },
];

// Self-modification briefing — how an engineer safely upgrades JARVIS itself.
const SELF_IMPROVE_RULES =
  "You are upgrading JARVIS — Daniel's personal AI (this repo). Read AGENTS.md first; follow the existing architecture " +
  "and design language (cockpit HUD, cyan/amber, Chakra Petch/Sora). New abilities usually mean: a tool in src/lib/tools.ts " +
  "(add to TOOL_DEFS + executeTool — both lanes pick it up automatically), a route in src/app/api/, or UI in " +
  "src/components/JarvisUI.tsx. VALIDATE proportionally before committing: for a small single-file change, re-read your " +
  "full diff line by line (the clone has no node_modules; Vercel's build is the gate and a failed deploy auto-files an " +
  "incident straight back to a repair agent). For multi-file or risky changes, run 'npm install' then 'npx tsc --noEmit' " +
  "and 'npm run build' — they must pass. Commit only working code, message starting 'self-improve:'. Vercel deploys it automatically. " +
  "If the change truly requires convex/ schema or src/trigger/ edits, keep them minimal and state clearly in your final " +
  "answer that they need a manual deploy. Never remove existing capabilities.";

const YT_ID = (s: string) => {
  const m = String(s).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/) ?? String(s).match(/^([\w-]{11})$/);
  return m ? m[1] : null;
};

async function serpapi(params: Record<string, string>): Promise<any> {
  const key = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));
  if (!key) return null;
  const qs = new URLSearchParams({ ...params, api_key: key });
  const r = await fetch(`https://serpapi.com/search.json?${qs}`);
  if (!r.ok) return null;
  return await r.json();
}

async function youtubeSearch(query: string): Promise<string> {
  const showList = async (vids: { id: string; title: string; channel: string; length: string }[]) => {
    const md = [`## YouTube · ${query}`, ""];
    vids.forEach((v, i) =>
      md.push(`${i + 1}. [${v.title}](https://www.youtube.com/watch?v=${v.id})`, `   ${v.channel} · ${v.length}`, ""),
    );
    await showResultsPanel(`youtube · ${query.slice(0, 36)}`, md.join("\n"));
  };
  // Free path: scrape ytInitialData from the results page.
  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "accept-language": "en" },
    });
    const html = await r.text();
    const m = html.match(/var ytInitialData = (\{[\s\S]+?\});<\/script>/);
    if (m) {
      const vids: { id: string; title: string; channel: string; length: string }[] = [];
      const walk = (o: any) => {
        if (!o || typeof o !== "object" || vids.length >= 6) return;
        if (o.videoRenderer?.videoId) {
          const v = o.videoRenderer;
          vids.push({
            id: v.videoId,
            title: v.title?.runs?.[0]?.text ?? "",
            channel: v.ownerText?.runs?.[0]?.text ?? "",
            length: v.lengthText?.simpleText ?? "",
          });
        } else for (const k of Object.keys(o)) walk(o[k]);
      };
      walk(JSON.parse(m[1]));
      if (vids.length) {
        await showList(vids);
        return (
          vids
            .map((v) => `${v.title} — ${v.channel} (${v.length}) https://www.youtube.com/watch?v=${v.id} [id:${v.id}]`)
            .join("\n") + "\n(The list is on Daniel's screen — offer to play one.)"
        );
      }
    }
  } catch {
    /* fall through */
  }
  const j = await serpapi({ engine: "youtube", search_query: query });
  const vids = (j?.video_results ?? []).slice(0, 6);
  if (!vids.length) return "No results found.";
  await showList(
    vids.map((v: any) => ({
      id: YT_ID(v.link) ?? "",
      title: v.title,
      channel: v.channel?.name ?? "",
      length: v.length ?? "",
    })),
  );
  return (
    vids.map((v: any) => `${v.title} — ${v.channel?.name ?? ""} (${v.length ?? ""}) ${v.link}`).join("\n") +
    "\n(The list is on Daniel's screen — offer to play one.)"
  );
}

async function youtubeTranscript(video: string): Promise<string> {
  const id = YT_ID(video);
  if (!id) return "Couldn't parse a YouTube video ID from that.";
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)" },
      body: JSON.stringify({
        videoId: id,
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en" } },
      }),
    });
    const j: any = await r.json();
    const title = j?.videoDetails?.title ?? "";
    const author = j?.videoDetails?.author ?? "";
    const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = tracks.find((t: any) => t.languageCode?.startsWith("en")) ?? tracks[0];
    if (!track?.baseUrl) {
      const desc = (j?.videoDetails?.shortDescription ?? "").slice(0, 1500);
      return `No captions available for "${title}" by ${author}. Description:\n${desc}`;
    }
    const xml = await (await fetch(track.baseUrl)).text();
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    return `"${title}" by ${author} — transcript:\n${text.slice(0, 12000)}`;
  } catch (e: any) {
    return `Transcript fetch failed: ${e?.message ?? e}`;
  }
}

// Searches always land on Daniel's screen as a full result list, not just in
// the model's head — he asked for multiple visible results every time.
async function showResultsPanel(title: string, md: string) {
  await convexMutation("ui:setPanel", { type: "markdown", value: md.slice(0, 7000), title }).catch(() => {});
}

async function webSearch(query: string): Promise<string> {
  const j = await serpapi({ engine: "google", q: query, num: "8" });
  if (!j) return "Search unavailable right now.";
  const parts: string[] = [];
  const md: string[] = [`## ${query}`, ""];
  if (j.answer_box?.answer || j.answer_box?.snippet) {
    const a = j.answer_box.answer ?? j.answer_box.snippet;
    parts.push(`Answer: ${a}`);
    md.push(`**${a}**`, "");
  }
  let n = 0;
  for (const r of (j.organic_results ?? []).slice(0, 8)) {
    n++;
    parts.push(`${r.title} — ${r.snippet ?? ""} (${r.link})`);
    md.push(`${n}. [${r.title}](${r.link})`, `   ${r.snippet ?? ""}`, "");
  }
  await showResultsPanel(`search · ${query.slice(0, 40)}`, md.join("\n"));
  return (parts.join("\n") || "No results.") + "\n(The full result list is on Daniel's screen.)";
}

// Google Flights rejects metro codes — map them to the main airport.
const METRO: Record<string, string> = {
  LON: "LHR", NYC: "JFK", PAR: "CDG", TYO: "NRT", MIL: "MXP", ROM: "FCO",
  STO: "ARN", MOW: "SVO", BER: "BER", CHI: "ORD", WAS: "IAD", SAO: "GRU", BUE: "EZE",
};

async function flightSearch(args: any): Promise<string> {
  const fix = (c: string) => METRO[c] ?? c;
  const params: Record<string, string> = {
    engine: "google_flights",
    departure_id: fix(String(args.from ?? "").toUpperCase().trim()),
    arrival_id: fix(String(args.to ?? "").toUpperCase().trim()),
    outbound_date: String(args.depart_date ?? ""),
    currency: "GBP",
    hl: "en",
  };
  if (args.return_date) params.return_date = String(args.return_date);
  else params.type = "2"; // one-way
  const j = await serpapi(params);
  if (!j) return "Flight search unavailable right now.";
  if (j.error) return `Flight search said: ${String(j.error).slice(0, 200)} (tip: use specific airport codes like LHR, not city codes)`;
  const flights = [...(j.best_flights ?? []), ...(j.other_flights ?? [])].slice(0, 8);
  if (!flights.length) return "No flights found for those airports/dates.";
  const lines: string[] = [];
  const md: string[] = [`## Flights ${params.departure_id} → ${params.arrival_id} · ${params.outbound_date}${args.return_date ? " – " + args.return_date : ""}`, ""];
  let n = 0;
  for (const f of flights) {
    n++;
    const legs = f.flights ?? [];
    const airlines = [...new Set(legs.map((l: any) => l.airline))].join(" + ");
    const stops = legs.length - 1;
    const dur = Math.round((f.total_duration ?? 0) / 60 * 10) / 10;
    const price = f.price ? `£${f.price}` : "?";
    lines.push(`${airlines}: ${price}, ${dur}h, ${stops === 0 ? "direct" : `${stops} stop${stops > 1 ? "s" : ""}`}`);
    md.push(`${n}. **${airlines}** — ${price} · ${dur}h · ${stops === 0 ? "direct" : `${stops} stop${stops > 1 ? "s" : ""}`}`);
    for (const l of legs) md.push(`   - ${l.departure_airport?.id} ${l.departure_airport?.time?.slice(-5) ?? ""} → ${l.arrival_airport?.id} ${l.arrival_airport?.time?.slice(-5) ?? ""} (${l.flight_number ?? ""})`);
    md.push("");
  }
  if (j.search_metadata?.google_flights_url) md.push(`[Open in Google Flights](${j.search_metadata.google_flights_url})`);
  await showResultsPanel(`flights · ${params.departure_id}→${params.arrival_id}`, md.join("\n"));
  return lines.slice(0, 5).join("\n") + "\n(Full list with times is on Daniel's screen — speak only the best one or two.)";
}

async function readUrl(url: string): Promise<string> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, redirect: "follow" });
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 8000) || "Page had no readable text.";
  } catch (e: any) {
    return `Couldn't read that page: ${e?.message ?? e}`;
  }
}

const RENTAL_URL = "https://hearty-oyster-600.convex.cloud";
async function rentalQuery(path: string, args: unknown): Promise<any> {
  try {
    const r = await fetch(`${RENTAL_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return (await r.json()).value;
  } catch {
    return null;
  }
}

async function rentalsCalendar(args: any): Promise<string> {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(args.start_date ?? "")) ? String(args.start_date) : new Date().toISOString().slice(0, 10);
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 30);
  const strip: any[] = await rentalQuery("calendar:getCalendarStrip", { accountSlug: null, startDate: start, days });
  if (!Array.isArray(strip)) return "Couldn't reach the rental calendar right now.";
  const spoken: string[] = [];
  const md: string[] = [`## Rental calendar · ${start} +${days}d`, ""];
  const short = (s: string) => String(s || "").split(/[|,]/)[0].split(/\s+/).slice(0, 4).join(" ");
  for (const day of strip) {
    const date = day.date ?? day.day ?? "";
    const away = (day.away ?? []).length;
    const pickups = (day.pickups ?? []).map((p: any) => short(p.items?.[0]?.name ?? p.imageAlt ?? "item"));
    const returns = (day.returns ?? []).map((p: any) => short(p.items?.[0]?.name ?? p.imageAlt ?? "item"));
    if (away || pickups.length || returns.length) {
      md.push(`**${date}** — ${away} out${pickups.length ? ` · pickup: ${pickups.join(", ")}` : ""}${returns.length ? ` · return: ${returns.join(", ")}` : ""}`);
      spoken.push(`${date}: ${away} out${pickups.length ? `, ${pickups.length} pickup` : ""}${returns.length ? `, ${returns.length} return` : ""}`);
    } else md.push(`**${date}** — clear`);
  }
  await showResultsPanel(`rentals · ${start}`, md.join("\n"));
  return (spoken.length ? spoken.join("\n") : `No rental activity between ${start} and +${days} days.`) + "\n(Full calendar is on Daniel's screen.)";
}

const WMO: Record<number, [string, string]> = {
  0: ["☀️", "clear"], 1: ["🌤", "mostly clear"], 2: ["⛅", "partly cloudy"], 3: ["☁️", "overcast"],
  45: ["🌫", "fog"], 48: ["🌫", "rime fog"], 51: ["🌦", "light drizzle"], 53: ["🌦", "drizzle"], 55: ["🌧", "heavy drizzle"],
  61: ["🌦", "light rain"], 63: ["🌧", "rain"], 65: ["🌧", "heavy rain"], 66: ["🌧", "freezing rain"], 67: ["🌧", "freezing rain"],
  71: ["🌨", "light snow"], 73: ["🌨", "snow"], 75: ["❄️", "heavy snow"], 77: ["❄️", "snow grains"],
  80: ["🌦", "light showers"], 81: ["🌧", "showers"], 82: ["⛈", "violent showers"],
  85: ["🌨", "snow showers"], 86: ["🌨", "snow showers"], 95: ["⛈", "thunderstorm"], 96: ["⛈", "thunderstorm + hail"], 99: ["⛈", "thunderstorm + hail"],
};

async function weatherWidget(args: any): Promise<string> {
  const place = String(args.location ?? "London").trim() || "London";
  try {
    const geo: any = await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en`)
    ).json();
    const g = geo?.results?.[0];
    if (!g) return `Couldn't find a place called ${place}.`;
    const f: any = await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
          `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=6`,
      )
    ).json();
    const cur = f?.current;
    if (!cur) return "Weather service is unavailable right now.";
    const [icon, desc] = WMO[cur.weather_code] ?? ["🌡", "weather"];
    const widget = {
      kind: "weather",
      place: `${g.name}${g.country_code ? ", " + g.country_code : ""}`,
      icon,
      desc,
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature),
      wind: Math.round(cur.wind_speed_10m),
      humidity: cur.relative_humidity_2m,
      days: (f.daily?.time ?? []).map((d: string, i: number) => ({
        day: new Date(d).toLocaleDateString("en-GB", { weekday: "short" }),
        icon: (WMO[f.daily.weather_code[i]] ?? ["🌡"])[0],
        max: Math.round(f.daily.temperature_2m_max[i]),
        min: Math.round(f.daily.temperature_2m_min[i]),
        rain: f.daily.precipitation_probability_max?.[i] ?? 0,
      })),
    };
    await convexMutation("ui:setPanel", { type: "widget", value: JSON.stringify(widget), title: `weather · ${widget.place}` });
    return `${widget.place}: ${widget.temp}°C, ${desc}, feels like ${widget.feels}°, wind ${widget.wind} km/h. (Widget is on Daniel's screen.)`;
  } catch (e: any) {
    return `Weather lookup failed: ${e?.message ?? e}`;
  }
}

async function activeThread(): Promise<string> {
  const t = await convexQuery("ui:getActiveThread", {});
  return typeof t === "string" && t ? t : "main";
}

export async function executeTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "dispatch_agent": {
      await convexMutation("jobs:enqueue", {
        task: String(args.task).slice(0, 2000),
        repo: args.repo ? String(args.repo) : undefined,
        model: args.model ? String(args.model) : undefined,
        mcp: Array.isArray(args.mcp) ? args.mcp.map(String) : undefined,
      });
      return "Agent dispatched. It'll report back here in a few minutes — keep the conversation going.";
    }
    case "show": {
      let { kind, value, title } = args as { kind?: string; value: string; title?: string };
      value = String(value ?? "").trim();
      if (!value) return "Nothing to show — give me a url, image, code or text.";
      // Models omit/confuse `kind` — infer and normalize so it always renders.
      const id = YT_ID(value);
      if (id) {
        kind = "video";
        value = `https://www.youtube.com/embed/${id}`;
      } else if (!kind || !["url", "video", "image", "code", "markdown", "site"].includes(kind)) {
        kind = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(value) ? "image" : /^https?:\/\//i.test(value) ? "url" : "markdown";
      }
      // Real sites block iframes almost universally (headers, CSP variants, JS
      // frame-busting) — websites always get the screenshot "site" viewport,
      // which looks embedded and scrolls. Only YouTube keeps a real iframe.
      if (kind === "url") kind = "site";
      await convexMutation("ui:setPanel", { type: kind, value: String(value), title: title ? String(title) : undefined });
      // Everything shown also lands in the stream as a persistent card.
      await convexMutation("chatQueue:postCard", {
        threadId: await activeThread(),
        type: kind,
        value: String(value).slice(0, 4000),
        title: title ? String(title) : undefined,
      }).catch(() => {});
      return "On screen now.";
    }
    case "hide":
      await convexMutation("ui:clearPanel", {});
      return "Cleared.";
    case "web_search":
      return await webSearch(String(args.query));
    case "flight_search":
      return await flightSearch(args);
    case "rentals_calendar":
      return await rentalsCalendar(args);
    case "weather":
      return await weatherWidget(args);
    case "clear_chat": {
      const t = await activeThread();
      const n = await convexMutation("chatQueue:clearThread", { threadId: t });
      return `Chat cleared (${n ?? 0} messages gone).`;
    }
    case "new_chat": {
      const id = `t${Date.now().toString(36)}`;
      await convexMutation("ui:setActiveThread", { thread: id });
      return "Fresh chat opened — the old one is saved in history.";
    }
    case "youtube_search":
      return await youtubeSearch(String(args.query));
    case "youtube_transcript":
      return await youtubeTranscript(String(args.video));
    case "read_url":
      return await readUrl(String(args.url));
    case "remember": {
      await convexMutation("memory:write", {
        kind: String(args.kind ?? "fact"),
        title: String(args.title).slice(0, 120),
        body: String(args.body).slice(0, 1200),
        tags: Array.isArray(args.tags) ? args.tags.map(String).slice(0, 6) : [],
      });
      const { vaultWrite } = await import("./obsidian");
      await vaultWrite(String(args.kind ?? "fact"), String(args.title), String(args.body));
      return "Saved to memory.";
    }
    case "memory_search": {
      const rows = await convexQuery("memory:search", { q: String(args.query), limit: 8 });
      return Array.isArray(rows) && rows.length
        ? rows.map((m: any) => `[${m.kind}] ${m.title}: ${m.body}`).join("\n")
        : "Nothing in memory for that.";
    }
    case "self_repair": {
      const problem = String(args.problem ?? "").slice(0, 1200);
      if (!problem) return "Tell me what's broken first.";
      const app = args.app ? String(args.app) : undefined;
      const incidentId = await convexMutation("incidents:report", {
        source: "brain",
        app,
        signature: `brain:${problem.slice(0, 100)}`,
        message: problem,
      });
      // Dispatch immediately — don't wait for the healer sweep.
      await convexMutation("incidents:setStatus", { id: incidentId, status: "dispatched" }).catch(() => {});
      await convexMutation("jobs:enqueue", {
        task:
          `SELF-REPAIR: trace the ROOT CAUSE and fix it — never paper over symptoms. Daniel reports: ${problem}\n` +
          `Method: 1) REPRODUCE (hit live endpoints, read the failing path). 2) Trace to the underlying cause. ` +
          `3) Minimal correct fix. 4) VALIDATE: 'npm install' + 'npx tsc --noEmit' must pass; 'npm run build' must pass for app code. ` +
          `5) Commit only working code ("self-repair: ..."). If it needs convex/ or src/trigger/ redeploy, commit and say so plainly.`,
        repo: app ?? "jarvis",
        model: "opus",
        incidentId: String(incidentId),
      });
      return "Repair engineer dispatched — it'll trace the root cause and the fix goes live automatically. Result gets woven in here.";
    }
    case "self_improve": {
      const request = String(args.request ?? "").slice(0, 1500);
      if (!request) return "Tell me what ability to build first.";
      await convexMutation("jobs:enqueue", {
        task: `${SELF_IMPROVE_RULES}\n\nThe upgrade Daniel wants: ${request}`,
        repo: "jarvis",
        model: "opus",
      });
      return "Upgrade engineer dispatched on my own code — validated changes deploy automatically in a few minutes.";
    }
    case "agent_status": {
      const [active, recent] = await Promise.all([convexQuery("jobs:active", {}), convexQuery("findings:recent", { limit: 4 })]);
      const a = Array.isArray(active) && active.length
        ? "Running: " + active.map((j: any) => `"${j.task.slice(0, 90)}" — ${j.progress || j.status}`).join("; ")
        : "No agents running.";
      const f = Array.isArray(recent) && recent.length
        ? "\nRecent findings: " + recent.map((r: any) => r.spoken).join(" | ")
        : "";
      return a + f;
    }
    case "current_time": {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(now);
      return formatted;
    }
    default:
      return `Unknown tool ${name}.`;
  }
}
