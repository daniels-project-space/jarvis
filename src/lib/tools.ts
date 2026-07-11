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
        model: { type: "string", enum: ["haiku", "sonnet", "opus"], description: "opus for hard engineering, sonnet default, haiku for trivial lookups" },
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
    description: "Quick web search (top results with snippets). For deeper digging, dispatch_agent instead.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
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
      if (vids.length)
        return vids
          .map((v) => `${v.title} — ${v.channel} (${v.length}) https://www.youtube.com/watch?v=${v.id} [id:${v.id}]`)
          .join("\n");
    }
  } catch {
    /* fall through */
  }
  const j = await serpapi({ engine: "youtube", search_query: query });
  const vids = (j?.video_results ?? []).slice(0, 6);
  if (!vids.length) return "No results found.";
  return vids.map((v: any) => `${v.title} — ${v.channel?.name ?? ""} (${v.length ?? ""}) ${v.link}`).join("\n");
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

async function webSearch(query: string): Promise<string> {
  const j = await serpapi({ engine: "google", q: query, num: "6" });
  if (!j) return "Search unavailable right now.";
  const parts: string[] = [];
  if (j.answer_box?.answer) parts.push(`Answer: ${j.answer_box.answer}`);
  if (j.answer_box?.snippet) parts.push(`Answer: ${j.answer_box.snippet}`);
  for (const r of (j.organic_results ?? []).slice(0, 6)) parts.push(`${r.title} — ${r.snippet ?? ""} (${r.link})`);
  return parts.join("\n") || "No results.";
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
      } else if (!kind || !["url", "video", "image", "code", "markdown"].includes(kind)) {
        kind = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(value) ? "image" : /^https?:\/\//i.test(value) ? "url" : "markdown";
      }
      await convexMutation("ui:setPanel", { type: kind, value: String(value), title: title ? String(title) : undefined });
      // Everything shown also lands in the stream as a persistent card.
      await convexMutation("chatQueue:postCard", {
        threadId: "main",
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
