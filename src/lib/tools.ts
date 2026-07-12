import "server-only";
import { convexMutation, convexQuery } from "./context";
import { getSecret } from "./vault";
import { r2Put, r2StoreFromUrl } from "./r2";

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
    name: "orchestrate",
    description:
      "Spawn a FLEET of parallel background agents on one mission — for big asks that decompose into independent workstreams (multi-angle research, building several pieces, auditing multiple repos, competitive analysis). YOU decompose the goal into 2-6 self-contained agent tasks; they run in parallel, the fleet view shows live progress, and when the last one lands the results are synthesized into ONE report back to Daniel. For single simple tasks use dispatch_agent instead.",
    parameters: {
      type: "object",
      properties: {
        mission: { type: "string", description: "the overall goal in one sentence" },
        agents: {
          type: "array",
          description: "2-6 independent workstreams",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "3-5 word fleet-view label" },
              task: { type: "string", description: "fully self-contained task incl. all context (agents start blank)" },
              repo: { type: "string", description: "owner/repo if it works on code" },
              model: { type: "string", enum: ["haiku", "sonnet", "opus"] },
              template: { type: "string", enum: ["research_report", "bug_fix", "feature_add", "refactor", "landing_page", "api_integration"], description: "method scaffold to enforce" },
            },
            required: ["label", "task"],
          },
        },
      },
      required: ["mission", "agents"],
    },
  },
  {
    name: "show",
    description:
      "Put something on Daniel's screen while you talk: a webpage, YouTube video, image, code, or notes. Use this for ANYTHING visual or detailed instead of reading it out. For videos, set play=true when he asked to PLAY/watch it (it autoplays); videos render 16:9 and shrink to picture-in-picture when he keeps talking.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["url", "video", "image", "code", "markdown"] },
        value: { type: "string", description: "url / YouTube link or ID / image url / code text / markdown text" },
        title: { type: "string", description: "Short label shown above the panel" },
        play: { type: "boolean", description: "video only: start playback immediately" },
      },
      required: ["kind", "value"],
    },
  },
  {
    name: "video_control",
    description:
      "Control the video currently on Daniel's screen (or in the picture-in-picture pill): play, pause, or close it. Use for 'play it / pause / stop / close the video / get rid of the mini player'.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["play", "pause", "close"] } },
      required: ["action"],
    },
  },
  {
    name: "open_travel_site",
    description:
      "Open a travel site ALREADY FILLED IN with Daniel's dates, destination and party (via deep-link parameters) — Booking.com, Airbnb, Google Flights or Skyscanner. If a trip is in progress, missing fields auto-fill from it. Use when he says 'open it on booking / put that into airbnb / bring up the flights page'.",
    parameters: {
      type: "object",
      properties: {
        site: { type: "string", enum: ["booking", "airbnb", "google_flights", "skyscanner"] },
        destination: { type: "string", description: "city or hotel name" },
        origin_iata: { type: "string", description: "flights only" },
        dest_iata: { type: "string", description: "flights only" },
        checkin: { type: "string", description: "YYYY-MM-DD" },
        checkout: { type: "string", description: "YYYY-MM-DD" },
        adults: { type: "number" },
      },
      required: ["site"],
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
    description:
      "THE tool for anything YouTube: 'X youtube', 'videos of/by X', a creator/channel name, 'watch something about X'. NEVER answer a video ask with web_search — this puts the numbered video lineup on Daniel's screen (three per page). Returns titles, channels, links, video IDs.",
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
    description:
      "Save a durable fact/preference/decision to long-term memory. Pass project when it belongs to a specific project (a script, a build, a board) — it files into that project's own Obsidian folder so you can always talk about it later.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["fact", "preference", "decision", "project", "task"] },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        project: { type: "string", description: "project slug, e.g. 'island-script'" },
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
    name: "rental_availability",
    description:
      "Is a specific piece of rental gear free? Searches Daniel's inventory by name (fx3, a7siii, 24-70 gm...) and returns per-item availability: free today, next free date, upcoming bookings. Use for ANY 'is X available / when is X free / do I have X' question.",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "gear name or fragment, e.g. 'fx3' or '24-70'" },
        days: { type: "number", description: "horizon in days, default 21" },
      },
      required: ["item"],
    },
  },
  {
    name: "rental_stats",
    description:
      "Daniel's rental business dashboard as a visual widget: monthly revenue chart, this month's earnings, active/upcoming rentals, fleet utilisation, top earners. Use for 'how's the rental business / revenue / best items' questions.",
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
    name: "market",
    description:
      "Live prices as a visual widget: crypto (bitcoin/ethereum/solana/any CoinGecko id) and stocks/commodities via ticker symbols (AAPL, TSLA, GC=F gold, ^GSPC S&P). Use for any price/market question.",
    parameters: {
      type: "object",
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "CoinGecko ids, default [bitcoin, ethereum, solana]" },
        symbols: { type: "array", items: { type: "string" }, description: "Yahoo tickers, e.g. [GC=F, AAPL]; default [GC=F]" },
      },
    },
  },
  {
    name: "timer",
    description: "Set a visual countdown timer on Daniel's screen (live ring, chimes when done). Use when he asks for a timer/reminder in minutes.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "duration in minutes" },
        label: { type: "string", description: "what it's for, e.g. 'pasta'" },
      },
      required: ["minutes"],
    },
  },
  {
    name: "briefing",
    description:
      "Daniel's full morning/evening briefing as one visual widget: weather, today's rentals (pickups/returns), open to-dos, next calendar events, net worth, live markets. Use for 'brief me / morning update / what's my day look like'. NEVER for trips or travel — trip_open owns those.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "todo_add",
    description:
      "ACTUALLY add an item to Daniel's real to-do list on the project hub (the widget on his dashboard). Use for ANY 'add to my list / remind me to / put X on my todos'. Never claim a to-do was added without calling this.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "the to-do text, short and actionable" },
        due_date: { type: "string", description: "YYYY-MM-DD if he gave a deadline" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["text"],
    },
  },
  {
    name: "todo_done",
    description: "Mark one of Daniel's hub to-dos as done. Pass a few words from the item's text.",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    name: "todo_remove",
    description: "Delete a to-do from Daniel's hub list entirely. Pass a few words from the item's text.",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    name: "calendar_add",
    description:
      "ACTUALLY add an event to Daniel's real calendar on the project hub. Use for ANY 'put X in my calendar / schedule / I have a meeting'. Never claim an event was added without calling this. Times are Europe/London.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM 24h; omit for an all-day event" },
        end_time: { type: "string", description: "HH:MM if he gave one" },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "calendar_remove",
    description: "Delete an event from Daniel's hub calendar. Pass a few words from its title.",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    name: "calendar_view",
    description:
      "Show Daniel's calendar as a beautiful visual widget: his hub events PLUS rental pickups/returns merged, as a day plan, week, or month view. Use for 'what's my day/week/month look like', 'show my calendar', 'what's on Friday'.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["day", "week", "month"], description: "default week" },
        date: { type: "string", description: "YYYY-MM-DD anchor, default today" },
      },
    },
  },
  {
    name: "open_app",
    description:
      "Launch one of Daniel's own apps on screen with a one-tap open button (rental manager, project hub, music house, youtube studio, media engine, remote work hub, app factory, jarvis...). Use for ANY 'open/launch/pull up <app>'.",
    parameters: {
      type: "object",
      properties: { app: { type: "string", description: "app name as Daniel said it, e.g. 'rental manager'" } },
      required: ["app"],
    },
  },
  {
    name: "research",
    description:
      "Verified research: runs SEVERAL searches, reads the top source, and cross-checks results before answering — slower than web_search but grounded. Use whenever the fact actually matters (specs, compatibility, prices to act on, medical/legal, anything Daniel will rely on) or when he says 'make sure / double check'.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "the thing to establish, self-contained" },
        queries: { type: "array", items: { type: "string" }, description: "2-3 different search angles; auto-generated if omitted" },
      },
      required: ["question"],
    },
  },
  {
    name: "deliberate",
    description:
      "Deep reasoning pass for genuinely hard calls: design decisions, creative direction, architecture, naming, strategy, anything with real trade-offs. Sends the problem (with your context) to a slow, strong reasoning model and returns a considered recommendation you deliver as your own view. Use BEFORE answering complicated design/creative questions instead of winging it.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "the decision/problem, fully self-contained" },
        context: { type: "string", description: "everything relevant Daniel said + constraints" },
      },
      required: ["question"],
    },
  },
  {
    name: "create_image",
    description:
      "Generate an image (Z-Image Turbo, ~8s, photoreal-capable) and show it on screen. It's stored permanently in the creations library. Use for 'make/generate/draw me an image/picture/logo/concept'.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "detailed visual prompt, English" },
        size: { type: "string", enum: ["1024*1024", "1280*720", "720*1280", "1152*864"], description: "default 1024*1024" },
        title: { type: "string", description: "short name for the library" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "store_image",
    description: "Save any image URL permanently into Daniel's creations library (re-hosted on his own storage).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, title: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "create_pdf",
    description:
      "Create a clean, downloadable PDF from markdown content (briefs, plans, quotes, letters, checklists) — shows on screen with a download link and is saved in the creations library.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        markdown: { type: "string", description: "the full document content as markdown (#/##/### headings, bullets, numbered lists)" },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: "board",
    description:
      "JARVIS's INFINITE CANVAS — a real freeform board (Excalidraw) you build and edit LIVE while talking: sticky notes, shapes, text, tables, arrows, clickable links (Spotify, references), and rendered images placed anywhere or into named ZONES. create with template 'film' gives a worldbuilding layout (characters / locations / moodboard / storyboard / playlist / notes zones). Use for brainstorming, film/script development, moodboards, project planning — ANY visual thinking. GROUNDING RULE: the board mirrors what DANIEL says and approves — never invent names, plot points or details he didn't confirm; PROPOSE out loud first, add after he agrees. update rewrites an existing item (match its text); remove deletes it — when he asks to change something, change THAT item, don't add a duplicate. To add a rendered picture: create_image first, then board add an image item with its URL into the right zone. Ask Daniel questions as you build (characters? tone? locations?) and keep adding as answers come. Daniel can drag/edit everything by hand too.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "add", "update", "remove", "show"] },
        match: { type: "string", description: "update/remove: a few words from the EXISTING item's text" },
        title: { type: "string", description: "board title (create/show)" },
        template: { type: "string", enum: ["film", "blank"], description: "create only, default blank" },
        project: { type: "string", description: "project slug this board belongs to (memory filing), e.g. 'island-script'" },
        items: {
          type: "array",
          description: "add only — high-level items; JARVIS places them (zone grid) unless x/y given",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["note", "text", "rectangle", "ellipse", "diamond", "arrow", "image", "table"] },
              text: { type: "string", description: "label/content" },
              zone: { type: "string", description: "named zone to place into (e.g. characters, moodboard)" },
              color: { type: "string", enum: ["green", "amber", "blue", "pink", "purple", "slate", "yellow"] },
              url: { type: "string", description: "makes it a clickable link (Spotify track, reference…)" },
              image_url: { type: "string", description: "kind=image: the picture URL (from create_image or the web)" },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "kind=table: rows, first row = header" },
              x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
              big: { type: "boolean", description: "kind=text: heading size" },
            },
            required: ["kind"],
          },
        },
      },
      required: ["action"],
    },
  },
  {
    name: "mind_map",
    description:
      "Create or LIVE-EDIT a visual mind map / diagram on Daniel's screen while you talk: bubbles (nodes), connectors (edges), colours, links, images, even little tables. Saved automatically in the creations library. action=create starts fresh; update edits the one on screen (upserts nodes by id, adds edges, removes by id); show re-opens a saved one by title.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "show"] },
        title: { type: "string", description: "map title (create/show)" },
        nodes: {
          type: "array",
          description: "nodes to add/update; id is a short slug; parent links it into the tree layout",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              detail: { type: "string", description: "one-line sub-text" },
              parent: { type: "string", description: "id of the node this hangs off" },
              color: { type: "string", description: "green|amber|blue|pink|slate, default green" },
              url: { type: "string", description: "makes the node a clickable link" },
              image: { type: "string", description: "image url shown inside the node" },
              rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "table rows for a table node" },
            },
            required: ["id", "label"],
          },
        },
        edges: {
          type: "array",
          description: "extra cross-connections beyond parent links",
          items: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } },
            required: ["from", "to"],
          },
        },
        remove: { type: "array", items: { type: "string" }, description: "node ids to remove (update only)" },
      },
      required: ["action"],
    },
  },
  {
    name: "chart",
    description:
      "Draw a data chart/dashboard on screen (KPI tiles, bar trend series, ranked bars) from numbers you provide, and save it in the creations library. Use when Daniel wants data visualised.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        kpis: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, prefix: { type: "string" }, suffix: { type: "string" } }, required: ["label", "value"] } },
        series: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } }, required: ["label", "value"] } },
        series_label: { type: "string" },
        bars: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, note: { type: "string" } }, required: ["label", "value"] } },
        bars_label: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "price_chart",
    description:
      "REAL price chart on screen: candlesticks with 20/50/200 moving averages, volume, RSI and auto-detected support/resistance — always in USD/USDT. Crypto (btc, eth, sol…), stocks (AAPL, TSLA), indices (S&P, Nasdaq, VIX), gold/oil/DXY. Use for ANY 'show me the chart / how's X looking' — never describe a chart without showing it.",
    parameters: {
      type: "object",
      properties: {
        asset: { type: "string", description: "e.g. 'btc', 'ethereum', 'AAPL', 's&p', 'gold'" },
        interval: { type: "string", enum: ["1h", "4h", "1d", "1w"], description: "default 1d" },
      },
      required: ["asset"],
    },
  },
  {
    name: "market_analysis",
    description:
      "Full professional read of an asset RIGHT NOW: regime, key levels, chart patterns with measured targets, Elliott-wave count with invalidation, Wyckoff accumulation/distribution phase, volume + funding/open-interest/fear-greed (crypto) or VIX regime (stocks), fresh news — then a direct verdict with entries, stops, targets. Annotated chart + full write-up land on screen. Use when Daniel asks to analyse / should-I-buy / what's happening with any asset. Takes ~20s — say you're running it.",
    parameters: {
      type: "object",
      properties: {
        asset: { type: "string" },
        interval: { type: "string", enum: ["4h", "1d", "1w"], description: "analysis anchor timeframe, default 1d" },
        question: { type: "string", description: "Daniel's specific angle, e.g. 'thinking of adding at 60k'" },
      },
      required: ["asset"],
    },
  },
  {
    name: "trip_open",
    description:
      "GLOBE FIRST: call this the INSTANT a trip/holiday/destination comes up, before saying anything or asking any question. Spawn the trip globe THE MOMENT a destination comes up in conversation — it appears immediately, centred on the place, and fills in live (flights, stays, activities, connections) as the planning talk continues. Call this first, then ask about budget/dates, then trip_plan.",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "city/region, e.g. 'Lisbon'" },
        dest_iata: { type: "string", description: "airport code if known, e.g. LIS" },
      },
      required: ["destination"],
    },
  },
  {
    name: "trip_plan",
    description:
      "Full travel scout — ONE call searches real flights (Google Flights), real hotels with amenities/total prices (Google Hotels), and top activities (Google Places) in parallel, then opens the interactive globe trip planner on screen. BUDGET IS REQUIRED: if Daniel hasn't given one, ASK HIM FIRST instead of calling this. Use for any 'plan a trip / find me a holiday / getaway to X'.",
    parameters: {
      type: "object",
      properties: {
        destination: { type: "string", description: "city/region, e.g. 'Barcelona'" },
        dest_iata: { type: "string", description: "destination airport IATA, e.g. BCN" },
        origin_iata: { type: "string", description: "departure airport IATA, default LHR" },
        depart_date: { type: "string", description: "YYYY-MM-DD" },
        return_date: { type: "string", description: "YYYY-MM-DD" },
        adults: { type: "number", description: "travellers, default 2" },
        budget_total_gbp: { type: "number", description: "TOTAL trip budget in GBP — required; ask Daniel if he didn't say" },
        include_flights: { type: "boolean", description: "REQUIRED decision: does he want flights scouted? If he hasn't said, ASK ('flights too? from where?') before calling" },
        vibe: { type: "string", description: "what he's after: beach, food, nightlife, culture, hiking…" },
        max_price_per_night: { type: "number", description: "hotel ceiling per night if he stated one (else derived from budget)" },
        vacation_rentals: { type: "boolean", description: "apartments/homes instead of hotels" },
      },
      required: ["destination", "dest_iata", "depart_date", "return_date"],
    },
  },
  {
    name: "trip_update",
    description:
      "Edit the current trip live: lock in a flight or hotel (lock_stay computes the real airport transfer from the hotel's location), add/remove activities, change the budget, or re-search hotels with different limits. The globe panel updates instantly.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["lock_flight", "lock_stay", "toggle_activity", "set_budget", "rescout_stays", "show"] },
        flight_index: { type: "number", description: "which flight from the list (1-based) for lock_flight" },
        stay: { type: "string", description: "hotel name (or fragment) for lock_stay" },
        activity: { type: "string", description: "activity name (or fragment) for toggle_activity" },
        budget_total_gbp: { type: "number" },
        max_price_per_night: { type: "number", description: "for rescout_stays" },
        vacation_rentals: { type: "boolean", description: "for rescout_stays" },
      },
      required: ["action"],
    },
  },
  {
    name: "trip_finalize",
    description:
      "Lock the plan in: builds the day-by-day itinerary (flight, airport transfer with real drive time, check-in, activities), writes every item into Daniel's calendar, and saves the whole trip as an interactive connected-node map in the creations library. Call when Daniel says 'book it in / lock it / finalize the plan'.",
    parameters: {
      type: "object",
      properties: {
        add_to_calendar: { type: "boolean", description: "default true" },
      },
    },
  },
  {
    name: "creations_list",
    description: "Open Daniel's creations library on screen — everything you've made (mind maps, charts, images, PDFs). Use for 'show my/your creations, where's that image/pdf/map'.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: ["canvas", "chart", "image", "pdf", "doc"], description: "filter, optional" } },
    },
  },
  {
    name: "shop_search",
    description:
      "SHOPPING CONCIERGE: find real products for Daniel (UK — pounds, UK retailers, fast delivery prioritised) with prices, merchant links and product images cut out onto presentation frames — shows THREE at a time. Use for any 'find/buy me X' (gifts, clothes, gear). After showing: ask which fits or what to change, refine with another search, and when he picks one OFFER to run the checkout agent (dispatch_agent with mcp:[\"browserbase\"] task: add the exact product to cart on the merchant site and return the checkout/payment link).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "specific product search, e.g. 'women's red bikini high waist'" },
        max_price_gbp: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "todo_list",
    description: "Pull up Daniel's ACTUAL to-do list from the hub as a tickable widget on screen — he can check items off right there. Use for 'show my todos / what's on my list'.",
    parameters: { type: "object", properties: { _noop: { type: "string" } } },
  },
  {
    name: "net_worth",
    description: "Daniel's net worth as a visual dashboard: total, cashflow, expenses, rental income, and the full asset breakdown by category as charts. Use for 'net worth / how's my money / portfolio'.",
    parameters: { type: "object", properties: { _noop: { type: "string" } } },
  },
  {
    name: "plan_my_day",
    description:
      "Build Daniel a PRIORITISED, time-blocked plan for the day: combines his open to-dos, calendar events, rental pickups/returns and deadlines into a realistic schedule with reasoning. Shows the plan on screen; offer to write the blocks into his calendar. Use for 'plan my day / what should I focus on / structure my day'.",
    parameters: {
      type: "object",
      properties: {
        focus: { type: "string", description: "anything Daniel said he wants prioritised today" },
        date: { type: "string", description: "YYYY-MM-DD, default today" },
      },
    },
  },
  {
    name: "orb_mood",
    description:
      "Slow mood ring — shift ONLY on a genuine sustained change of register (server ignores changes within 4 minutes). Shift the orb's colour to match the conversation's tone — it fades slowly into the new colour and stays a while. Use when the mood genuinely changes: calm (green, default), focused (blue, work/markets), dreamy (purple, creative), warm (amber, personal/friendly), serious (steel, hard talks/money decisions), alert (red, problems), excited (pink, wins/big ideas).",
    parameters: {
      type: "object",
      properties: { mood: { type: "string", enum: ["calm", "focused", "dreamy", "warm", "serious", "alert", "excited"] } },
      required: ["mood"],
    },
  },
  {
    name: "news_today",
    description:
      "Today's news as a CINEMATIC visual feed: full-screen story cards with images that fade through, then a browsable grid. Use for 'news of the day / what's happening / news about X'. Speak a 2-line digest while it plays.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", description: "optional focus, e.g. 'AI', 'markets', 'Portugal'" } },
    },
  },
  {
    name: "music_search",
    description:
      "Find music on Spotify and present it as a visual feed with album art — tap opens Spotify. Use for 'find that song / music for the playlist / something like X'.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "song/artist/vibe" } },
      required: ["query"],
    },
  },
  {
    name: "transport_route",
    description:
      "Show a LIVE interactive Google Map with directions between two places (transit/driving/walking) — routes, times and options, embedded on screen. Use for 'how do I get from X to Y', airport transfers, trip transport questions.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "origin place/address" },
        to: { type: "string", description: "destination place/address" },
        mode: { type: "string", enum: ["transit", "driving", "walking", "bicycling"], description: "default transit" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "memory_map",
    description:
      "Show Daniel's memory as a visual node tree on screen (his Obsidian vault mind: projects, decisions, facts, preferences clustered and linked). Use for 'show me your memory / what do you remember / memory map'.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "optional focus filter" } },
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

// Method scaffolds appended to fleet/agent tasks (adapted from the
// ethanplusai/jarvis prompt-template library) — they raise output quality by
// enforcing a working method per task type.
const TASK_TEMPLATES: Record<string, string> = {
  research_report:
    "\n\nMETHOD (research): search MULTIPLE independent sources; cite URLs for every claim; clearly separate facts from opinion; compare alternatives in a table when they exist; end with concrete, actionable recommendations. Never settle for the first result.",
  bug_fix:
    "\n\nMETHOD (bug fix): 1) REPRODUCE the bug first and state how. 2) Trace the ROOT CAUSE — never paper over symptoms. 3) Minimal correct fix. 4) Validate proportionally (single-file: line-by-line diff review; multi-file: npx tsc --noEmit + build). 5) Commit only working code ('fix: ...').",
  feature_add:
    "\n\nMETHOD (feature): read the surrounding code style first and match it; smallest coherent implementation; wire it end-to-end (no dead UI); validate with tsc/build; commit 'feat: ...' and state exactly what was added and where.",
  refactor:
    "\n\nMETHOD (refactor): behaviour must be IDENTICAL after — list the invariants first; prefer deletion over abstraction; keep commits mechanical and reviewable; validate with tsc/build; state LOC delta.",
  landing_page:
    "\n\nMETHOD (landing page): distinctive visual direction (no template-y defaults), real copy (no lorem), responsive, one clear call-to-action; validate the build passes; describe the design choices in one paragraph.",
  api_integration:
    "\n\nMETHOD (API integration): read the API docs first and cite the endpoints used; handle auth via the secrets vault; graceful failure paths (timeouts, rate limits); prove it works with a real request/response transcript in your answer.",
};

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
  // Videos arrive as a tappable THUMBNAIL selection list — nothing autoplays;
  // Daniel picks one (or says "play the second one").
  const showList = async (vids: { id: string; title: string; channel: string; length: string }[]) => {
    await showWidget(
      {
        kind: "feed",
        mode: "videos",
        label: `youtube · ${query.slice(0, 36)}`,
        items: vids.map((v) => ({
          image: `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
          title: v.title.slice(0, 100),
          subtitle: `${v.channel.slice(0, 40)} · ${v.length}`,
          video_id: v.id,
        })),
      },
      `youtube · ${query.slice(0, 36)}`,
    );
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
            .map((v, i) => `${i + 1}. ${v.title} — ${v.channel} (${v.length}) [id:${v.id}]`)
            .join("\n") +
          "\n(Thumbnail list is on Daniel's screen, ready to tap — NOTHING is playing. If he asks to play one, use show with the video id and play:true.)"
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
    vids.map((v: any, i: number) => `${i + 1}. ${v.title} — ${v.channel?.name ?? ""} (${v.length ?? ""}) [id:${YT_ID(v.link) ?? ""}]`).join("\n") +
    "\n(Thumbnail list is on Daniel's screen, ready to tap — NOTHING is playing. If he asks to play one, use show with the video id and play:true.)"
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

async function rentalAvailability(args: any): Promise<string> {
  const item = String(args.item ?? "").trim();
  if (!item) return "Which item, sir?";
  const days = Math.min(Math.max(Number(args.days) || 21, 1), 60);
  const v = await rentalQuery("calendar:getItemAvailabilityForChat", { query: item, horizonDays: days, accountSlug: null });
  if (!v || typeof v !== "object") return "Couldn't reach the rental system right now.";
  if (!v.match_count) return `No gear matching "${item}" in the inventory.`;
  const lines: string[] = [];
  const md: string[] = [`## Availability · ${item}`, ""];
  for (const it of (v.items ?? []).slice(0, 6)) {
    const state = it.free_today
      ? `${it.free_units_today}/${it.qty} free today`
      : `booked out — next free ${it.next_free_date ?? "unknown"}`;
    lines.push(`${it.name}: ${state}`);
    md.push(`**${it.name}** (${it.kind}, qty ${it.qty}) — ${state}`);
    for (const b of (it.upcoming_bookings ?? []).slice(0, 4))
      md.push(`   - out ${b.pickup} → ${b.return ?? b.return_date ?? "?"} (${b.account ?? ""})`);
    md.push("");
  }
  await showResultsPanel(`availability · ${item}`, md.join("\n"));
  return lines.join("\n") + "\n(Details are on Daniel's screen.)";
}

async function rentalStats(): Promise<string> {
  const [stats, earners, util, series] = await Promise.all([
    rentalQuery("dashboard:getStatsDrawerData", { accountSlug: null, _bypassMv: true }), // null = every account combined
    rentalQuery("mv/top_earners:getRanking", {}),
    rentalQuery("mv/utilization:get", {}),
    rentalQuery("mv/earnings_by_period:get", { granularity: "monthly", months: 6 }),
  ]);
  if (!stats) return "Couldn't reach the rental dashboard right now.";
  const m = stats.monthly ?? {};
  const act = stats.active ?? {};
  const short = (s: string) => String(s || "").split(/[|,]/)[0].split(/\s+/).slice(0, 4).join(" ");
  const widget: Record<string, any> = {
    kind: "stats",
    title: "Rental business",
    kpis: [
      { label: "this month", value: Math.round(m.current_earnings ?? 0), prefix: "£" },
      { label: "active now", value: act.ongoing_count ?? 0 },
      { label: "upcoming", value: act.upcoming_count ?? 0 },
      { label: "fleet in use", value: Math.round(util?.fleetUtilizationPct ?? 0), suffix: "%" },
    ],
    series: (Array.isArray(series) ? series : []).map((p: any) => ({
      label: String(p.period).slice(2),
      value: Math.round(p.revenue ?? 0),
    })),
    seriesLabel: "monthly revenue £",
    bars: (Array.isArray(earners) ? earners : []).slice(0, 5).map((e: any) => ({
      label: short(e.itemName),
      value: Math.round(e.net30dGbp ?? 0),
      note: `${e.rentalCount} rentals`,
    })),
    barsLabel: "top earners (30d) £",
  };
  await showWidget(widget, "rental business");
  const bestMonth = widget.series.reduce((a: any, b: any) => (b.value > (a?.value ?? 0) ? b : a), null);
  return (
    `This month £${widget.kpis[0].value}, ${widget.kpis[1].value} active, ${widget.kpis[2].value} upcoming, fleet ${widget.kpis[3].value}% used.` +
    (bestMonth ? ` Best recent month: ${bestMonth.label} at £${bestMonth.value}.` : "") +
    " (Full dashboard widget is on Daniel's screen — speak one highlight only.)"
  );
}

const WMO: Record<number, [string, string]> = {
  0: ["☀️", "clear"], 1: ["🌤", "mostly clear"], 2: ["⛅", "partly cloudy"], 3: ["☁️", "overcast"],
  45: ["🌫", "fog"], 48: ["🌫", "rime fog"], 51: ["🌦", "light drizzle"], 53: ["🌦", "drizzle"], 55: ["🌧", "heavy drizzle"],
  61: ["🌦", "light rain"], 63: ["🌧", "rain"], 65: ["🌧", "heavy rain"], 66: ["🌧", "freezing rain"], 67: ["🌧", "freezing rain"],
  71: ["🌨", "light snow"], 73: ["🌨", "snow"], 75: ["❄️", "heavy snow"], 77: ["❄️", "snow grains"],
  80: ["🌦", "light showers"], 81: ["🌧", "showers"], 82: ["⛈", "violent showers"],
  85: ["🌨", "snow showers"], 86: ["🌨", "snow showers"], 95: ["⛈", "thunderstorm"], 96: ["⛈", "thunderstorm + hail"], 99: ["⛈", "thunderstorm + hail"],
};

// Show a widget AND drop a recallable card in the stream (tap = re-show later).
async function showWidget(widget: Record<string, unknown>, title: string) {
  const json = JSON.stringify(widget);
  await convexMutation("ui:setPanel", { type: "widget", value: json, title });
  if (json.length < 3900)
    await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "widget", value: json, title }).catch(
      () => {},
    );
}

async function fetchWeatherData(place: string): Promise<any | null> {
  const geo: any = await (
    await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en`)
  ).json();
  const g = geo?.results?.[0];
  if (!g) return null;
  const f: any = await (
    await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
        `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
        `&hourly=temperature_2m,weather_code,precipitation_probability&forecast_hours=12` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=8`,
    )
  ).json();
  const cur = f?.current;
  if (!cur) return null;
  const [icon, desc] = WMO[cur.weather_code] ?? ["🌡", "weather"];
  return {
    kind: "weather",
    lat: g.latitude,
    lng: g.longitude,
    hours: (f.hourly?.time ?? []).map((h: string, i: number) => ({
      h: h.slice(11, 16),
      t: Math.round(f.hourly.temperature_2m[i]),
      icon: (WMO[f.hourly.weather_code[i]] ?? ["🌡"])[0],
      rain: f.hourly.precipitation_probability?.[i] ?? 0,
    })),
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
}

async function weatherWidget(args: any): Promise<string> {
  const place = String(args.location ?? "London").trim() || "London";
  try {
    const w = await fetchWeatherData(place);
    if (!w) return `Couldn't find weather for ${place}.`;
    await showWidget(w, `weather · ${w.place}`);
    return `${w.place}: ${w.temp}°C, ${w.desc}, feels like ${w.feels}°, wind ${w.wind} km/h. (Widget is on Daniel's screen.)`;
  } catch (e: any) {
    return `Weather lookup failed: ${e?.message ?? e}`;
  }
}

async function fetchMarketData(coins: string[], symbols: string[]): Promise<any[]> {
  const rows: any[] = [];
  try {
    if (coins.length) {
      // USD always — Daniel doesn't want crypto quoted in pounds
      const cg: any = await (
        await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coins.map(encodeURIComponent).join(",")}&vs_currencies=usd&include_24hr_change=true`,
        )
      ).json();
      for (const id of coins) {
        const c = cg?.[id];
        if (c?.usd != null)
          rows.push({ label: id.replace(/-/g, " "), price: c.usd, change: Math.round((c.usd_24h_change ?? 0) * 100) / 100, unit: "$" });
      }
    }
  } catch {
    /* partial data is fine */
  }
  for (const sym of symbols.slice(0, 5)) {
    try {
      const y: any = await (
        await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1h`, {
          headers: { "user-agent": "Mozilla/5.0" },
        })
      ).json();
      const meta = y?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice != null) {
        const prev = meta.chartPreviousClose || meta.regularMarketPrice;
        const names: Record<string, string> = { "GC=F": "gold", "^GSPC": "S&P 500", "^IXIC": "nasdaq", "BTC-USD": "bitcoin $" };
        rows.push({
          label: names[sym] ?? sym,
          price: meta.regularMarketPrice,
          change: Math.round(((meta.regularMarketPrice - prev) / prev) * 10000) / 100,
          unit: meta.currency === "GBP" ? "£" : meta.currency === "USD" ? "$" : "",
        });
      }
    } catch {
      /* skip symbol */
    }
  }
  return rows;
}

async function marketWidget(args: any): Promise<string> {
  const coins = Array.isArray(args.coins) && args.coins.length ? args.coins.map(String) : ["bitcoin", "ethereum", "solana"];
  const symbols = Array.isArray(args.symbols) && args.symbols.length ? args.symbols.map(String) : ["GC=F"];
  const rows = await fetchMarketData(coins, symbols);
  if (!rows.length) return "Market data is unavailable right now.";
  await showWidget({ kind: "market", title: "Markets", rows, at: new Date().toISOString() }, "markets");
  return (
    rows.map((r) => `${r.label}: ${r.unit}${r.price.toLocaleString("en-GB")} (${r.change >= 0 ? "+" : ""}${r.change}%)`).join(", ") +
    ". (Widget is on Daniel's screen.)"
  );
}

async function timerWidget(args: any): Promise<string> {
  const minutes = Math.min(Math.max(Number(args.minutes) || 0, 0.1), 24 * 60);
  if (!minutes) return "How long, sir?";
  const label = String(args.label ?? "timer").slice(0, 60);
  const until = Date.now() + Math.round(minutes * 60_000);
  await showWidget({ kind: "timer", label, until, total: Math.round(minutes * 60_000) }, `⏱ ${label}`);
  return `Timer set — ${minutes} minute${minutes === 1 ? "" : "s"} for ${label}. It'll chime on screen when done.`;
}

async function briefingWidget(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const [w, strip, todos, events, wealth, markets, mem] = await Promise.all([
    fetchWeatherData("London").catch(() => null),
    rentalQuery("calendar:getCalendarStrip", { accountSlug: null, startDate: today, days: 1 }),
    q_hub("todos:list"),
    q_hub("events:list"),
    q_hub("wealth:getWealth"),
    fetchMarketData(["bitcoin", "ethereum"], ["GC=F"]).catch(() => []),
    convexQuery("memory:recent", { limit: 8 }).catch(() => []),
  ]);
  const short = (x: string) => String(x || "").split(/[|,]/)[0].split(/\s+/).slice(0, 4).join(" ");
  const day0 = Array.isArray(strip) ? strip[0] : null;
  // rentals as a TIMELINE: markers with times + cards
  const rentalMarks: { time: string; kind: string; name: string }[] = [];
  for (const pck of day0?.pickups ?? []) rentalMarks.push({ time: pck.pickupTime || "12:00", kind: "pickup", name: short(pck.items?.[0]?.name ?? pck.imageAlt ?? "item") });
  for (const r of day0?.returns ?? []) rentalMarks.push({ time: r.returnTime || "18:00", kind: "return", name: short(r.items?.[0]?.name ?? r.imageAlt ?? "item") });
  const open = (Array.isArray(todos) ? todos : []).filter((t: any) => !t.done);
  // DAY-RELEVANT todo pick: fast model pass with his context (memory + time)
  let picked: { text: string; why: string }[] = [];
  try {
    const gk = process.env.GROQ_API_KEY ?? (await getSecret("groq", "GROQ_API_KEY").catch(() => ""));
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${gk}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content:
          `It is ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "long", hour: "2-digit", minute: "2-digit" })} in London where Daniel is. ` +
          `His fixed commitments today: ${rentalMarks.map((m) => m.kind + " " + m.name + " " + m.time).join("; ") || "none"}. ` +
          `Recent context about him: ${(Array.isArray(mem) ? mem : []).map((x: any) => x.title).join("; ").slice(0, 500)}. ` +
          `From his open to-dos below, pick the 4-6 genuinely DOABLE TODAY given the time left and his context; for each give a 5-word why. ` +
          `STRICT JSON {"picks":[{"text":"<exact todo text>","why":"..."}]}.
TODOS: ${open.slice(0, 20).map((t: any) => JSON.stringify(String(t.text).slice(0, 90))).join(", ")}` }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const pj: any = await resp.json();
    picked = (JSON.parse(pj.choices?.[0]?.message?.content ?? "{}").picks ?? []).slice(0, 6);
  } catch { /* fall back below */ }
  if (!picked.length) picked = open.slice(0, 5).map((t: any) => ({ text: String(t.text).slice(0, 90), why: "" }));
  const now = Date.now();
  const upcoming = (Array.isArray(events) ? events : []).filter((e: any) => (e.start ?? 0) >= now).sort((a: any, b: any) => a.start - b.start).slice(0, 4);
  const widget = {
    kind: "briefing2",
    date: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
    weather: w ? { icon: w.icon, temp: w.temp, desc: w.desc, hours: (w.hours ?? []).slice(0, 8) } : null,
    wealth: wealth?.currentTotalGBP ? Math.round(wealth.currentTotalGBP) : null,
    rentals: rentalMarks.sort((a, b) => a.time.localeCompare(b.time)),
    awayCount: (day0?.away ?? []).length,
    todos: picked,
    calendar: upcoming.map((e: any) => ({
      title: String(e.title).slice(0, 60),
      when: new Date(e.start).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + (e.allDay ? "" : " " + londonTimeStr(e.start)),
    })),
    markets: (markets ?? []).map((r: any) => ({ label: r.label, price: r.price, change: r.change, unit: r.unit })),
  };
  await showWidget(widget, `briefing · ${today}`);
  return (
    `Briefing 2.0 on screen (rentals timeline, tickable day-picks, calendar, markets). ` +
    `Spoken summary material: ${w ? w.temp + "° " + w.desc : ""}; ${rentalMarks.length} rental movements; top pick: ${picked[0]?.text ?? "none"}. Speak two short sentences max.`
  );
}

// project-hub reads (todos/calendar/wealth live there)
const HUB_URL = "https://fantastic-roadrunner-485.convex.cloud";
async function q_hub(path: string, args: unknown = {}): Promise<any> {
  try {
    const r = await fetch(`${HUB_URL}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    return (await r.json()).value;
  } catch {
    return null;
  }
}
// project-hub WRITES — the missing half that made "added to your list, sir" a
// lie: JARVIS could only read the hub. These actually mutate the dashboard.
async function m_hub(path: string, args: unknown): Promise<any> {
  const r = await fetch(`${HUB_URL}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await r.json();
  if (j.status === "error") throw new Error(j.errorMessage ?? `${path} failed`);
  return j.value;
}

// "2026-07-14" + "15:30" in Europe/London → epoch ms (DST-correct).
function londonMs(date: string, time?: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = (time ?? "09:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  const asLondon = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +(parts.hour === "24" ? 0 : parts.hour), +parts.minute);
  return guess - (asLondon - guess);
}
const londonDateStr = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const londonTimeStr = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

async function todoAdd(args: any): Promise<string> {
  const text = String(args.text ?? "").trim();
  if (!text) return "What should the to-do say?";
  await m_hub("todos:add", {
    text: text.slice(0, 200),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(args.due_date ?? "")) ? londonMs(String(args.due_date), "12:00") : undefined,
    tags: Array.isArray(args.tags) ? args.tags.map(String).slice(0, 4) : ["jarvis"],
  });
  const open = ((await q_hub("todos:list")) ?? []).filter((t: any) => !t.done).length;
  return `Done — "${text}" is now on the hub to-do list (${open} open). Confirm it casually in one line.`;
}

async function matchTodo(match: string, includeDone: boolean): Promise<{ hit: any | null; note: string }> {
  const todos: any[] = (await q_hub("todos:list")) ?? [];
  const pool = includeDone ? todos : todos.filter((t: any) => !t.done);
  const m = match.toLowerCase().trim();
  const hits = pool.filter((t: any) => String(t.text).toLowerCase().includes(m));
  if (hits.length === 1) return { hit: hits[0], note: "" };
  if (hits.length === 0)
    return {
      hit: null,
      note: `TOOL FAILED — nothing changed. No to-do matches "${match}". Tell Daniel honestly. Items: ${pool.slice(0, 8).map((t: any) => `"${t.text}"`).join(", ") || "none"}.`,
    };
  return { hit: null, note: `TOOL DID NOTHING — several match "${match}": ${hits.slice(0, 5).map((t: any) => `"${t.text}"`).join(", ")} — ask Daniel which one.` };
}

async function todoDone(args: any): Promise<string> {
  const { hit, note } = await matchTodo(String(args.match ?? ""), false);
  if (!hit) return note;
  await m_hub("todos:update", { id: hit._id, done: true });
  return `Ticked off: "${hit.text}".`;
}

async function todoRemove(args: any): Promise<string> {
  // removal must also find already-done items, not just open ones
  const { hit, note } = await matchTodo(String(args.match ?? ""), true);
  if (!hit) return note;
  await m_hub("todos:remove", { id: hit._id });
  return `Removed from the list: "${hit.text}".`;
}

async function calendarAdd(args: any): Promise<string> {
  const title = String(args.title ?? "").trim();
  const date = String(args.date ?? "");
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "I need a title and a date (YYYY-MM-DD).";
  const allDay = !args.time;
  const start = londonMs(date, args.time ? String(args.time) : "09:00");
  const end = args.end_time ? londonMs(date, String(args.end_time)) : undefined;
  await m_hub("events:create", {
    title: title.slice(0, 140),
    start,
    end,
    allDay,
    color: "brass",
    location: args.location ? String(args.location).slice(0, 140) : undefined,
    notes: args.notes ? String(args.notes).slice(0, 500) : undefined,
  });
  return `In the calendar: "${title}" on ${date}${args.time ? ` at ${args.time}` : " (all day)"}. It'll show in briefings too. Confirm casually in one line.`;
}

async function calendarRemove(args: any): Promise<string> {
  const events: any[] = (await q_hub("events:list")) ?? [];
  const m = String(args.match ?? "").toLowerCase().trim();
  const hits = events.filter((e: any) => String(e.title).toLowerCase().includes(m));
  if (hits.length === 0) return `No event matches "${args.match}".`;
  if (hits.length > 1)
    return `Several events match: ${hits.slice(0, 5).map((e: any) => `"${e.title}" (${londonDateStr(e.start)})`).join(", ")} — ask which.`;
  await m_hub("events:remove", { id: hits[0]._id });
  return `Deleted "${hits[0].title}" from the calendar.`;
}

// The frosted-glass calendar widget: hub events + rental pickups/returns in
// one day / week / month view.
async function calendarView(args: any): Promise<string> {
  const view = ["day", "week", "month"].includes(String(args.view)) ? String(args.view) : "week";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date ?? "")) ? String(args.date) : londonDateStr(Date.now());
  const anchorMs = londonMs(anchor, "12:00");
  const DAY = 86_400_000;
  let startMs: number, count: number;
  if (view === "day") {
    startMs = anchorMs;
    count = 1;
  } else if (view === "week") {
    const dow = (new Date(anchorMs).getUTCDay() + 6) % 7; // Monday = 0 (close enough at noon London)
    startMs = anchorMs - dow * DAY;
    count = 7;
  } else {
    const [y, mo] = anchor.split("-").map(Number);
    const first = londonMs(`${y}-${String(mo).padStart(2, "0")}-01`, "12:00");
    const dow = (new Date(first).getUTCDay() + 6) % 7;
    startMs = first - dow * DAY;
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    count = Math.ceil((dow + daysInMonth) / 7) * 7;
  }
  const stripStart = londonDateStr(startMs);
  const [events, strip] = await Promise.all([
    q_hub("events:list"),
    rentalQuery("calendar:getCalendarStrip", { accountSlug: null, startDate: stripStart, days: Math.min(count, 30) }),
  ]);
  const byDate: Record<string, any[]> = {};
  for (const e of Array.isArray(events) ? events : []) {
    const d = londonDateStr(e.start);
    (byDate[d] ??= []).push({
      title: String(e.title).slice(0, 60),
      time: e.allDay ? "" : londonTimeStr(e.start),
      kind: "event",
      location: e.location ? String(e.location).slice(0, 40) : undefined,
    });
  }
  const short = (s: string) => String(s || "").split(/[|,]/)[0].split(/\s+/).slice(0, 3).join(" ");
  for (const day of Array.isArray(strip) ? strip : []) {
    const d = day.date ?? day.day ?? "";
    for (const p of day.pickups ?? []) (byDate[d] ??= []).push({ title: `↑ ${short(p.items?.[0]?.name ?? p.imageAlt ?? "pickup")}`, time: p.pickupTime ?? "", kind: "pickup" });
    for (const r of day.returns ?? []) (byDate[d] ??= []).push({ title: `↓ ${short(r.items?.[0]?.name ?? r.imageAlt ?? "return")}`, time: "", kind: "return" });
    if ((day.away ?? []).length) (byDate[d] ??= []).push({ title: `${(day.away ?? []).length} out`, time: "", kind: "away" });
  }
  const anchorMonth = anchor.slice(0, 7);
  const days = Array.from({ length: count }, (_, i) => {
    const ms = startMs + i * DAY;
    const date = londonDateStr(ms);
    return {
      date,
      dow: new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(ms),
      inMonth: view !== "month" || date.slice(0, 7) === anchorMonth,
      today: date === londonDateStr(Date.now()),
      events: (byDate[date] ?? []).sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(0, view === "month" ? 3 : 12),
      more: Math.max(0, (byDate[date] ?? []).length - (view === "month" ? 3 : 12)),
    };
  });
  const label =
    view === "day"
      ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long" }).format(anchorMs)
      : view === "week"
        ? `Week of ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(startMs)}`
        : new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "long", year: "numeric" }).format(anchorMs);
  await showWidget({ kind: "calendar", view, anchor, label, days }, `calendar · ${label}`);
  const busyDays = days.filter((d) => d.events.length);
  const spokenBits = busyDays.slice(0, 4).map((d) => `${d.dow} ${d.date.slice(8)}: ${d.events.slice(0, 3).map((e: any) => e.title).join(", ")}`);
  return (
    `Calendar (${label}) is on screen.` +
    (spokenBits.length ? ` Highlights — ${spokenBits.join("; ")}.` : " Nothing scheduled.") +
    " (Speak one short sentence only.)"
  );
}

// Daniel's own apps — "open the rental manager" should actually open it.
const APPS: { name: string; url: string; aliases: string[] }[] = [
  { name: "Rental Manager", url: "https://rental-manager-v2-nu.vercel.app", aliases: ["rental manager", "rentals app", "rmv2", "rental-manager", "hygglo dashboard"] },
  { name: "Project Hub", url: "https://project-hub-olive-pi.vercel.app", aliases: ["project hub", "the hub", "dashboard", "project-hub"] },
  { name: "Music House", url: "https://music-house-nine.vercel.app", aliases: ["music house", "music-house", "music app"] },
  { name: "YouTube Studio AI", url: "https://youtube-studio-ai.vercel.app", aliases: ["youtube studio", "ysa", "youtube app", "video factory"] },
  { name: "Remote Work Hub", url: "https://remote-work-hub-sepia.vercel.app", aliases: ["remote work hub", "rwh", "work hub", "agents hub"] },
  { name: "Media Engine", url: "https://media-engine-seven.vercel.app", aliases: ["media engine", "media-engine"] },
  { name: "App Factory", url: "https://app-factory-v2.vercel.app", aliases: ["app factory", "factory", "app-factory"] },
  { name: "JARVIS", url: "https://jarvis-orcin-six.vercel.app", aliases: ["jarvis", "yourself", "your ui"] },
];

async function openApp(args: any): Promise<string> {
  const want = String(args.app ?? "").toLowerCase().trim();
  const app =
    APPS.find((a) => a.aliases.some((al) => want.includes(al) || al.includes(want))) ??
    APPS.find((a) => a.name.toLowerCase().includes(want));
  if (!app)
    return `I don't have a live URL for "${args.app}". Apps I can open: ${APPS.map((a) => a.name).join(", ")}.`;
  await convexMutation("ui:setPanel", { type: "launch", value: JSON.stringify({ name: app.name, url: app.url }), title: `launch · ${app.name}` });
  await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "url", value: app.url, title: `open ${app.name} ↗` }).catch(() => {});
  return `${app.name} is on screen with a one-tap open button (it also auto-opens in a new tab if the browser allows). URL: ${app.url}`;
}

// Verified research: several search angles + the top source read, so the answer
// isn't whatever the first result happened to say.
async function researchTool(args: any): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) return "What do you want me to establish?";
  const queries: string[] = (Array.isArray(args.queries) && args.queries.length
    ? args.queries.map(String)
    : [question, `${question} explained details`, `${question} reddit OR forum experience`]
  ).slice(0, 3);
  const results = await Promise.all(queries.map((q) => serpapi({ engine: "google", q, num: "6" })));
  const md: string[] = [`## Research · ${question}`, ""];
  const forModel: string[] = [];
  let firstLink = "";
  results.forEach((j, i) => {
    if (!j) return;
    md.push(`### Angle ${i + 1}: ${queries[i]}`);
    if (j.answer_box?.answer || j.answer_box?.snippet) {
      const a = j.answer_box.answer ?? j.answer_box.snippet;
      md.push(`**Answer box:** ${a}`, "");
      forModel.push(`[angle ${i + 1} answer box] ${a}`);
    }
    for (const r of (j.organic_results ?? []).slice(0, 4)) {
      if (!firstLink && r.link) firstLink = r.link;
      md.push(`- [${r.title}](${r.link}) — ${r.snippet ?? ""}`);
      forModel.push(`[${new URL(r.link ?? "https://x.x").hostname}] ${r.title}: ${r.snippet ?? ""}`);
    }
    md.push("");
  });
  let pageExcerpt = "";
  if (firstLink) {
    pageExcerpt = (await readUrl(firstLink)).slice(0, 5000);
    md.push(`### Read: ${firstLink}`, pageExcerpt.slice(0, 1200) + "…");
  }
  await showResultsPanel(`research · ${question.slice(0, 36)}`, md.join("\n"));
  return (
    `MULTI-SOURCE RESULTS (cross-check before answering — if sources disagree, say so and go with the best-supported one, naming it):\n` +
    forModel.join("\n").slice(0, 5000) +
    (pageExcerpt ? `\n\nTOP SOURCE FULL TEXT (${firstLink}):\n${pageExcerpt.slice(0, 3500)}` : "") +
    "\n(The full sourced breakdown is on Daniel's screen.)"
  );
}

// Hard calls get a slow, strong reasoning model instead of a reflex answer.
async function deliberateTool(args: any): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) return "What's the decision?";
  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return "Deep reasoning is unavailable (no OpenAI key).";
  const prompt =
    `You are the deep-reasoning core of JARVIS, advising Daniel (a solo builder/designer who ships fast and values taste).\n` +
    `Think hard about the problem, weigh the real trade-offs, then give:\n` +
    `1) A clear recommendation (one line).\n2) The 2-4 decisive reasons.\n3) What would change your mind.\n` +
    `Be concrete and opinionated; no fence-sitting.\n\nPROBLEM: ${question}\n\nCONTEXT:\n${String(args.context ?? "").slice(0, 3000)}`;
  for (const model of ["gpt-5.1", "gpt-5", "o4-mini"]) {
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: prompt, reasoning: { effort: "high" }, max_output_tokens: 2000 }),
        signal: AbortSignal.timeout(75_000),
      });
      if (!r.ok) continue;
      const j: any = await r.json();
      const text =
        j.output_text ??
        (Array.isArray(j.output)
          ? j.output
              .flatMap((o: any) => (Array.isArray(o.content) ? o.content : []))
              .filter((c: any) => c.type === "output_text")
              .map((c: any) => c.text)
              .join("\n")
          : "");
      if (text && text.trim()) {
        await showResultsPanel(`deliberation · ${question.slice(0, 36)}`, `## ${question}\n\n${text}`);
        return `CONSIDERED ANALYSIS (deliver the recommendation as your own view, in your voice, short — full version is on his screen):\n${text.slice(0, 4000)}`;
      }
    } catch {
      /* try next model */
    }
  }
  return "The reasoning pass failed — answer from your own judgement and say it wasn't double-checked.";
}

// Z-Image Turbo via Novita — generated art is re-homed to R2 (provider URLs
// die in 48h) and saved in the creations library.
async function createImage(args: any): Promise<string> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return "Describe the image first.";
  const key = process.env.NOVITA_API_KEY ?? (await getSecret("novita", "NOVITA_API_KEY").catch(() => ""));
  if (!key) return "Image generation is unavailable (no Novita key in the vault).";
  const size = ["1024*1024", "1280*720", "720*1280", "1152*864"].includes(String(args.size)) ? String(args.size) : "1024*1024";
  const submit = await fetch("https://api.novita.ai/v3/async/z-image-turbo", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: prompt.slice(0, 1800), size }),
  });
  if (!submit.ok) return `Image generation failed to start: ${submit.status} ${(await submit.text()).slice(0, 120)}`;
  const { task_id } = await submit.json();
  if (!task_id) return "Image generation failed to start (no task id).";
  let imageUrl = "";
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll: any = await (
      await fetch(`https://api.novita.ai/v3/async/task-result?task_id=${task_id}`, {
        headers: { Authorization: `Bearer ${key}` },
      })
    ).json();
    const status = poll?.task?.status;
    if (status === "TASK_STATUS_SUCCEED") {
      imageUrl = poll?.images?.[0]?.image_url ?? "";
      break;
    }
    if (status === "TASK_STATUS_FAILED") return `Image generation failed: ${poll?.task?.reason ?? "unknown reason"}`;
  }
  if (!imageUrl) return "Image generation timed out after 30s — try again.";
  const title = String(args.title ?? prompt.slice(0, 60));
  let finalUrl = imageUrl;
  try {
    finalUrl = (await r2StoreFromUrl(title, imageUrl)).url;
  } catch (e: any) {
    // fall back to the (48h) provider url — but surface the breakage so the
    // healer fixes it instead of it rotting silently
    await convexMutation("incidents:report", {
      source: "tools",
      signature: "r2:create-image-store",
      message: `R2 re-home of generated image failed: ${String(e?.message ?? e).slice(0, 200)}`,
    }).catch(() => {});
  }
  await convexMutation("creations:create", { kind: "image", title, url: finalUrl, thumb: finalUrl, data: prompt }).catch(() => {});
  await convexMutation("ui:setPanel", { type: "image", value: finalUrl, title });
  await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "image", value: finalUrl, title }).catch(() => {});
  return `Image generated and on screen (saved to the creations library). URL: ${finalUrl}`;
}

async function storeImage(args: any): Promise<string> {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//.test(url)) return "Give me a valid image URL.";
  const title = String(args.title ?? "stored image").slice(0, 80);
  try {
    const { url: stored } = await r2StoreFromUrl(title, url);
    await convexMutation("creations:create", { kind: "image", title, url: stored, thumb: stored }).catch(() => {});
    await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "image", value: stored, title }).catch(() => {});
    return `Stored permanently in the creations library: ${stored}`;
  } catch (e: any) {
    return `Couldn't store that image: ${e?.message ?? e}`;
  }
}

async function createPdf(args: any): Promise<string> {
  const title = String(args.title ?? "").trim() || "Document";
  const md = String(args.markdown ?? "").trim();
  if (!md) return "Give me the document content first.";
  try {
    const { markdownToPdf } = await import("./pdf");
    const bytes = await markdownToPdf(title, md.slice(0, 30_000));
    const url = await r2Put(title, bytes, "application/pdf");
    await convexMutation("creations:create", { kind: "pdf", title, url, data: md.slice(0, 20_000) }).catch(() => {});
    await convexMutation("ui:setPanel", { type: "pdf", value: url, title });
    await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "pdf", value: url, title: `${title}.pdf` }).catch(() => {});
    return `PDF ready and on screen — download link: ${url} (also saved in the creations library).`;
  } catch (e: any) {
    return `PDF creation failed: ${e?.message ?? e}`;
  }
}

// The infinite canvas: high-level items → excalidraw ops the open board
// applies live (see src/lib/board.ts + BoardView).
async function boardTool(args: any): Promise<string> {
  const { createBoard, loadBoard, saveBoardDoc, itemToOps } = await import("./board");
  const action = String(args.action ?? "");
  if (action === "create") {
    const title = String(args.title ?? "Board").slice(0, 80);
    const template = ["film", "blank"].includes(String(args.template)) ? String(args.template) : "blank";
    const { doc } = await createBoard(title, template, args.project ? String(args.project) : undefined);
    return (
      `Board "${title}" is live on screen (zones: ${Object.keys(doc.zones).join(", ")}). ` +
      `Add items with board/add into those zones as the conversation flows — and ASK Daniel the next good question about the project. ` +
      `For pictures: create_image first, then add {kind:"image", image_url, zone}.`
    );
  }
  const b = await loadBoard(args.title ? String(args.title) : undefined);
  if (!b) return action === "show" ? "No board found — create one first." : "No board to add to — board/create first.";
  if (action === "show") {
    await saveBoardDoc(b.id, b.doc, true);
    return `Board "${b.doc.title}" is back on screen. Zones: ${Object.keys(b.doc.zones).join(", ")}.`;
  }
  if (action === "update" || action === "remove") {
    const match = String(args.match ?? "").trim();
    if (!match) return "Which item? Give me a few words from its text (match).";
    b.doc.pendingOps.push({
      ts: Date.now(),
      kind: action === "remove" ? "delete" : "edit",
      match,
      text: args.items?.[0]?.text ? String(args.items[0].text).slice(0, 600) : args.text ? String(args.text).slice(0, 600) : undefined,
    });
    await saveBoardDoc(b.id, b.doc, true);
    return `${action === "remove" ? "Removing" : "Rewriting"} the item matching "${match}" — applied live on the board.`;
  }
  if (action === "add") {
    const items = (Array.isArray(args.items) ? args.items : []).slice(0, 20);
    if (!items.length) return "Give me items to add.";
    let added = 0;
    for (const item of items) {
      try {
        b.doc.pendingOps.push(...itemToOps(b.doc, item));
        added++;
      } catch {
        /* skip malformed item */
      }
    }
    await saveBoardDoc(b.id, b.doc, true);
    return `${added} item(s) placed on "${b.doc.title}" — they appear live. Zones: ${Object.keys(b.doc.zones).join(", ")}. Keep building or ask Daniel what's next.`;
  }
  return "board actions: create, add, show.";
}

// Live mind map: create/update re-render on Daniel's screen as you talk.
async function mindMap(args: any): Promise<string> {
  const action = ["create", "update", "show"].includes(String(args.action)) ? String(args.action) : "create";
  const cleanNodes = (Array.isArray(args.nodes) ? args.nodes : [])
    .filter((n: any) => n?.id && n?.label)
    .slice(0, 60)
    .map((n: any) => ({
      id: String(n.id).slice(0, 40),
      label: String(n.label).slice(0, 60),
      detail: n.detail ? String(n.detail).slice(0, 90) : undefined,
      parent: n.parent ? String(n.parent).slice(0, 40) : undefined,
      color: ["green", "amber", "blue", "pink", "slate"].includes(n.color) ? n.color : undefined,
      url: n.url && /^https?:\/\//.test(String(n.url)) ? String(n.url).slice(0, 300) : undefined,
      image: n.image && /^https?:\/\//.test(String(n.image)) ? String(n.image).slice(0, 300) : undefined,
      rows: Array.isArray(n.rows) ? n.rows.slice(0, 6).map((r: any) => (Array.isArray(r) ? r.slice(0, 4).map(String) : [String(r)])) : undefined,
    }));
  const cleanEdges = (Array.isArray(args.edges) ? args.edges : [])
    .filter((e: any) => e?.from && e?.to)
    .slice(0, 80)
    .map((e: any) => ({ from: String(e.from), to: String(e.to), label: e.label ? String(e.label).slice(0, 30) : undefined }));

  // Models refer to nodes loosely ("rental-expansion" for id "rental") — match
  // refs against real ids AND labels so parents/edges never silently detach.
  const resolveId = (ref: string | undefined, pool: { id: string; label: string }[]): string | undefined => {
    if (!ref) return undefined;
    const r = ref.toLowerCase().trim();
    const rs = r.replace(/[^a-z0-9]+/g, "-");
    const exact = pool.find((n) => n.id.toLowerCase() === r || n.id.toLowerCase() === rs);
    if (exact) return exact.id;
    const byLabel =
      pool.find((n) => n.label.toLowerCase() === r) ??
      pool.find(
        (n) =>
          n.label.toLowerCase().includes(r) ||
          r.includes(n.label.toLowerCase()) ||
          n.id.toLowerCase().includes(rs) ||
          rs.includes(n.id.toLowerCase()),
      );
    return byLabel?.id;
  };
  const resolveRefs = (nodes: any[], edges: any[]) => {
    const pool = nodes.map((n: any) => ({ id: n.id, label: n.label }));
    for (const n of nodes) if (n.parent) n.parent = resolveId(n.parent, pool.filter((p) => p.id !== n.id)) ?? n.parent;
    let dropped = 0;
    const good = edges.filter((e: any) => {
      e.from = resolveId(e.from, pool) ?? "";
      e.to = resolveId(e.to, pool) ?? "";
      if (!e.from || !e.to || e.from === e.to) {
        dropped++;
        return false;
      }
      return true;
    });
    return { good, dropped };
  };

  if (action === "create") {
    const title = String(args.title ?? "Mind map").slice(0, 80);
    if (!cleanNodes.length) return "Give me at least one node.";
    const { good } = resolveRefs(cleanNodes, cleanEdges);
    const doc = { title, nodes: cleanNodes, edges: good };
    const id = await convexMutation("creations:create", { kind: "canvas", title, data: JSON.stringify(doc) });
    await convexMutation("ui:setPanel", { type: "canvas", value: JSON.stringify({ ...doc, creationId: String(id) }), title: `map · ${title}` });
    return `Mind map "${title}" is live on screen. Node ids: ${cleanNodes.map((n: any) => n.id).join(", ")}. Keep talking — use mind_map update (these exact ids) to add/change/remove as the conversation flows.`;
  }

  const existing: any = await convexQuery("creations:latest", { kind: "canvas", titleMatch: args.title ? String(args.title) : undefined });
  if (!existing?.data) return action === "show" ? "No saved mind map found — create one first." : "There's no mind map to update — use action=create.";
  let doc: any;
  try {
    doc = JSON.parse(existing.data);
  } catch {
    return "The saved map is corrupted — create a fresh one.";
  }

  let droppedEdges = 0;
  if (action === "update") {
    const byId: Record<string, any> = Object.fromEntries((doc.nodes ?? []).map((n: any) => [n.id, n]));
    for (const n of cleanNodes) byId[n.id] = { ...byId[n.id], ...n };
    for (const rid of Array.isArray(args.remove) ? args.remove.map(String) : []) {
      const real = resolveId(String(rid), Object.values(byId).map((n: any) => ({ id: n.id, label: n.label })));
      if (real) delete byId[real];
    }
    doc.nodes = Object.values(byId).slice(0, 80);
    const { good, dropped } = resolveRefs(doc.nodes, [...(doc.edges ?? []), ...cleanEdges]);
    droppedEdges = dropped;
    doc.edges = good
      .filter((e: any, i: number, a: any[]) => a.findIndex((x) => x.from === e.from && x.to === e.to) === i)
      .slice(0, 100);
    if (args.title) doc.title = String(args.title).slice(0, 80);
    await convexMutation("creations:update", { id: existing._id, title: doc.title, data: JSON.stringify(doc) });
  }
  await convexMutation("ui:setPanel", {
    type: "canvas",
    value: JSON.stringify({ ...doc, creationId: String(existing._id) }),
    title: `map · ${doc.title}`,
  });
  return action === "update"
    ? `Map updated live (${doc.nodes.length} nodes). Node ids: ${doc.nodes.map((n: any) => n.id).join(", ")}.${droppedEdges ? ` ${droppedEdges} connection(s) referenced unknown nodes and were skipped — use the ids listed.` : ""}`
    : `Mind map "${doc.title}" is back on screen. Node ids: ${doc.nodes.map((n: any) => n.id).join(", ")}.`;
}

async function chartTool(args: any): Promise<string> {
  const title = String(args.title ?? "Chart").slice(0, 80);
  const widget: Record<string, any> = {
    kind: "stats",
    title,
    kpis: (Array.isArray(args.kpis) ? args.kpis : []).slice(0, 6).map((k: any) => ({
      label: String(k.label).slice(0, 24),
      value: Number(k.value) || 0,
      prefix: k.prefix ? String(k.prefix) : undefined,
      suffix: k.suffix ? String(k.suffix) : undefined,
    })),
    series: (Array.isArray(args.series) ? args.series : []).slice(0, 14).map((s: any) => ({ label: String(s.label).slice(0, 12), value: Number(s.value) || 0 })),
    seriesLabel: args.series_label ? String(args.series_label) : undefined,
    bars: (Array.isArray(args.bars) ? args.bars : []).slice(0, 8).map((b: any) => ({ label: String(b.label).slice(0, 32), value: Number(b.value) || 0, note: b.note ? String(b.note) : "" })),
    barsLabel: args.bars_label ? String(args.bars_label) : undefined,
  };
  if (!widget.kpis.length && !widget.series.length && !widget.bars.length) return "Give me some numbers to chart (kpis, series or bars).";
  await showWidget(widget, title);
  await convexMutation("creations:create", { kind: "chart", title, data: JSON.stringify(widget) }).catch(() => {});
  return `Chart "${title}" is on screen and saved in the creations library. Speak one takeaway.`;
}

// News as a cinematic feed: hero cards with images fading through, then a grid.
async function newsToday(args: any): Promise<string> {
  const key = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));
  if (!key) return "News unavailable (no search key).";
  const topic = args.topic ? String(args.topic).trim() : "";
  const qs = new URLSearchParams({ engine: "google_news", gl: "us", hl: "en", api_key: key });
  if (topic) qs.set("q", topic);
  else qs.set("topic_token", "CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB"); // top stories
  const j: any = await (await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(9000) })).json();
  const raw: any[] = (j?.news_results ?? []).flatMap((n: any) => (n.stories ? n.stories : [n]));
  const items = raw
    .filter((n: any) => n.thumbnail && n.title)
    .slice(0, 12)
    .map((n: any) => ({
      image: String(n.thumbnail),
      title: String(n.title).slice(0, 140),
      subtitle: `${n.source?.name ?? ""}${n.date ? " · " + n.date : ""}`,
      url: String(n.link ?? ""),
    }));
  if (!items.length) return "No picture-worthy stories found right now.";
  await showWidget({ kind: "feed", mode: "news", label: topic ? `news · ${topic}` : "news of the day", items }, `news · ${topic || "today"}`);
  return (
    `NEWS FEED is playing on screen (hero cards, then the grid). Headlines: ` +
    items.slice(0, 6).map((i) => i.title).join(" | ") +
    ` — speak a natural 2-line digest of the most important 2-3, with your read on them.`
  );
}

// Spotify search → visual feed with album art (client-credentials flow).
let spotifyToken: { value: string; until: number } | null = null;
async function musicSearch(args: any): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "What music?";
  try {
    if (!spotifyToken || spotifyToken.until < Date.now()) {
      const creds = await (await import("./vault")).getServiceSecrets("spotify");
      const id = creds.SPOTIFY_CLIENT_ID ?? creds.CLIENT_ID;
      const secret = creds.SPOTIFY_CLIENT_SECRET ?? creds.CLIENT_SECRET;
      if (!id || !secret) return "Spotify credentials missing from the vault.";
      const r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
        body: "grant_type=client_credentials",
      });
      const tokenBody = await r.text();
      let tj: any = {};
      try {
        tj = JSON.parse(tokenBody);
      } catch {
        return `Spotify token endpoint answered non-JSON (${r.status}): ${tokenBody.slice(0, 140)}`;
      }
      if (!tj.access_token) return `Spotify auth failed: ${JSON.stringify(tj).slice(0, 120)}`;
      spotifyToken = { value: tj.access_token, until: Date.now() + (tj.expires_in - 60) * 1000 };
    }
    const searchRes = await fetch(`https://api.spotify.com/v1/search?type=track&limit=10&q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${spotifyToken.value}`, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const searchBody = await searchRes.text();
    let sr: any = {};
    try {
      sr = JSON.parse(searchBody);
    } catch {
      spotifyToken = null; // maybe a stale/garbled token — refetch next time
      return `Spotify search answered non-JSON (${searchRes.status}): ${searchBody.slice(0, 140)}`;
    }
    const items = (sr?.tracks?.items ?? []).map((t: any) => ({
      image: t.album?.images?.[0]?.url ?? "",
      title: String(t.name).slice(0, 80),
      subtitle: `${t.artists?.map((a: any) => a.name).join(", ")} · ${t.album?.name ?? ""}`.slice(0, 90),
      url: t.external_urls?.spotify ?? "",
    })).filter((i: any) => i.image);
    if (!items.length) return `Nothing on Spotify for "${query}".`;
    await showWidget({ kind: "feed", mode: "music", label: `music · ${query}`, items }, `music · ${query.slice(0, 30)}`);
    return `MUSIC FEED on screen (album art, tap opens Spotify): ${items.slice(0, 5).map((i: any) => `${i.title} — ${i.subtitle.split("·")[0]}`).join(" | ")}. Speak your pick and why.`;
  } catch (e: any) {
    return `Spotify search failed: ${e?.message ?? e}`;
  }
}

// Live Google Maps directions embedded on screen.
async function transportRoute(args: any): Promise<string> {
  const from = String(args.from ?? "").trim();
  const to = String(args.to ?? "").trim();
  if (!from || !to) return "From where to where?";
  const mode = ["transit", "driving", "walking", "bicycling"].includes(String(args.mode)) ? String(args.mode) : "transit";
  const key = await getSecret("google", "GOOGLE_PLACES_API_KEY").catch(() => "");
  if (!key) return "Maps key unavailable.";
  const url = `https://www.google.com/maps/embed/v1/directions?key=${key}&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&mode=${mode}`;
  await convexMutation("ui:setPanel", { type: "url", value: url, title: `route · ${from.slice(0, 20)} → ${to.slice(0, 20)}` });
  await convexMutation("chatQueue:postCard", {
    threadId: await activeThread(),
    type: "url",
    value: `https://www.google.com/maps/dir/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
    title: `route ${from.slice(0, 18)} → ${to.slice(0, 18)} ↗`,
  }).catch(() => {});
  return `Live ${mode} directions ${from} → ${to} are on screen (interactive map — he can pan and switch routes). Speak the gist if you know it; the map has the times.`;
}

// The Obsidian mind, visualised: memory rows clustered by kind on the canvas.
async function memoryMapTool(args: any): Promise<string> {
  const q = args.query ? String(args.query) : "";
  const rows: any[] = q
    ? ((await convexQuery("memory:search", { q, limit: 30 })) ?? [])
    : ((await convexQuery("memory:recent", { limit: 36 })) ?? []);
  if (!rows.length) return "Memory came back empty for that.";
  const kinds = [...new Set(rows.map((m: any) => String(m.kind)))];
  const nodes: any[] = [{ id: "mind", label: q ? `memory · ${q}` : "JARVIS memory", color: "green" }];
  const edges: any[] = [];
  for (const k of kinds) nodes.push({ id: `k-${k}`, label: k.toUpperCase(), parent: "mind", color: "amber" });
  rows.slice(0, 34).forEach((m: any, i: number) => {
    nodes.push({ id: `m${i}`, label: String(m.title).slice(0, 46), detail: String(m.body).slice(0, 80), parent: `k-${String(m.kind)}`, color: "blue" });
  });
  const doc = { title: q ? `Memory · ${q}` : "Memory map", nodes, edges };
  await convexMutation("ui:setPanel", { type: "canvas", value: JSON.stringify(doc), title: doc.title });
  return `Memory tree is on screen: ${rows.length} memories across ${kinds.join(", ")}. The full vault lives in Obsidian (jarvis-memory repo).`;
}

// Shopping concierge: Google Shopping (UK) -> product cards with cutout-style
// images on frames, three at a time.
async function shopSearch(args: any): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "What am I finding?";
  const key = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));
  if (!key) return "Shopping search unavailable.";
  const qs = new URLSearchParams({ engine: "google_shopping", q: query, gl: "uk", hl: "en", num: "20", api_key: key });
  const j: any = await (await fetch(`https://serpapi.com/search.json?${qs}`, { signal: AbortSignal.timeout(10000) })).json();
  if (j?.error) return `Shopping search failed: ${String(j.error).slice(0, 120)}`;
  const FAST = /same.day|next.day|tomorrow|\b1 day|\b1-2 day|24 ?h/i;
  let items = (j?.shopping_results ?? [])
    .filter((r: any) => r.thumbnail && r.extracted_price)
    .map((r: any) => ({
      image: String(r.thumbnail),
      title: String(r.title).slice(0, 90),
      priceNum: Number(r.extracted_price),
      price: String(r.price ?? `£${r.extracted_price}`).slice(0, 14),
      merchant: String(r.source ?? "").slice(0, 30),
      delivery: String(r.delivery ?? "").slice(0, 40),
      rating: r.rating,
      reviews: r.reviews,
      url: String(r.product_link ?? r.link ?? ""),
    }));
  const cap = Number(args.max_price_gbp) || 0;
  if (cap) items = items.filter((i: any) => i.priceNum <= cap);
  // genuinely fast delivery floats up ("free delivery on £120+" is not fast)
  items.sort((a: any, b: any) => (FAST.test(b.delivery) ? 1 : 0) - (FAST.test(a.delivery) ? 1 : 0));
  items = items.slice(0, 12).map(({ priceNum, ...i }: any) => i);
  if (!items.length) return `Nothing solid for "${query}" — refine the search terms.`;
  await showWidget({ kind: "shop", label: query, items }, `shopping · ${query.slice(0, 30)}`);
  return (
    `SHOP FRAMES on screen (numbered, three per page — he pages with the on-screen arrows). Top picks: ` +
    items.slice(0, 3).map((i: any, n: number) => `${n + 1}. ${i.title} — ${i.price} at ${i.merchant}${i.delivery ? " (" + i.delivery + ")" : ""}`).join(" | ") +
    ` — ask Daniel which fits or what to change. If he picks one: offer the checkout agent (dispatch_agent, mcp browserbase, task: open the merchant page, add EXACTLY that item to the cart, fill the order details, proceed to checkout and return the payment-page link - NEVER pay).`
  );
}

// Day planner (mined from ethanplusai/jarvis planner.py, web-adapted): real
// commitments + open to-dos → a reasoned, time-blocked schedule.
async function planMyDay(args: any): Promise<string> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date ?? "")) ? String(args.date) : londonDateStr(Date.now());
  const [todos, events, strip] = await Promise.all([
    q_hub("todos:list"),
    q_hub("events:list"),
    rentalQuery("calendar:getCalendarStrip", { accountSlug: null, startDate: date, days: 1 }),
  ]);
  const open = (Array.isArray(todos) ? todos : []).filter((t: any) => !t.done);
  const dayEvents = (Array.isArray(events) ? events : []).filter((e: any) => londonDateStr(e.start) === date);
  const day0 = Array.isArray(strip) ? strip[0] : null;
  const short = (s: string) => String(s || "").split(/[|,]/)[0].split(/\s+/).slice(0, 4).join(" ");
  const facts =
    `DATE: ${date} (now ${londonTimeStr(Date.now())} London)\n` +
    `FIXED EVENTS: ${dayEvents.map((e: any) => `${e.allDay ? "all-day" : londonTimeStr(e.start)} ${e.title}`).join("; ") || "none"}\n` +
    `RENTALS TODAY: ${day0 ? [...(day0.pickups ?? []).map((p: any) => `pickup ${short(p.items?.[0]?.name ?? "")}${p.pickupTime ? " " + p.pickupTime : ""}`), ...(day0.returns ?? []).map((r: any) => `return ${short(r.items?.[0]?.name ?? "")}`)].join("; ") || "none" : "unknown"}\n` +
    `OPEN TO-DOS (${open.length}): ${open.slice(0, 18).map((t: any) => `"${String(t.text).slice(0, 70)}"${t.dueDate ? ` (due ${londonDateStr(t.dueDate)})` : ""}${t.priority ? ` [p${t.priority}]` : ""}`).join("; ")}\n` +
    (args.focus ? `DANIEL WANTS PRIORITISED: ${String(args.focus).slice(0, 300)}\n` : "");
  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return "Planner core unavailable.";
  let plan = "";
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.1",
        instructions:
          "You are JARVIS planning Daniel's day. He's a solo builder running rental + content businesses; deep-work blocks matter more than busywork. " +
          "Produce markdown: '## Today's plan' then time blocks (HH:MM–HH:MM — thing, one-line why), respecting fixed events/rentals, batching errands, " +
          "max 3 meaningful priorities, realistic breaks, and an honest '## Skip today' list for the to-dos that shouldn't happen. Under 300 words.",
        input: facts,
        reasoning: { effort: "medium" },
        max_output_tokens: 5000,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.ok) {
      const j: any = await r.json();
      plan =
        j.output_text ??
        (Array.isArray(j.output)
          ? j.output.flatMap((o: any) => (Array.isArray(o.content) ? o.content : [])).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("\n")
          : "");
    }
  } catch {
    /* fall through */
  }
  if (!plan.trim()) return "The planner pass failed — build a quick plan yourself from the briefing data.";
  await showResultsPanel(`plan · ${date}`, plan);
  await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "markdown", value: plan.slice(0, 3900), title: `day plan · ${date}` }).catch(() => {});
  return `PLAN READY (on screen + card). Speak the top priority and first block only, then offer to write the blocks into his calendar (calendar_add per block if he says yes):\n${plan.slice(0, 2500)}`;
}

// "Open it filled in": travel sites accept everything as URL parameters — the
// page loads with Daniel's dates, destination and party already applied.
async function openTravelSite(args: any): Promise<string> {
  const site = String(args.site ?? "");
  // Missing fields auto-fill from the trip in progress.
  let trip: any = null;
  try {
    const { latestTrip } = await import("./travel");
    trip = (await latestTrip())?.doc ?? null;
  } catch {
    /* no trip — fine */
  }
  const destination = String(args.destination ?? trip?.locked?.stay?.name ?? trip?.destination ?? "").trim();
  const checkin = /^\d{4}-\d{2}-\d{2}$/.test(String(args.checkin ?? "")) ? String(args.checkin) : trip?.departDate ?? "";
  const checkout = /^\d{4}-\d{2}-\d{2}$/.test(String(args.checkout ?? "")) ? String(args.checkout) : trip?.returnDate ?? "";
  const adults = Math.max(1, Number(args.adults) || trip?.adults || 2);
  const oIata = String(args.origin_iata ?? trip?.origin ?? "LHR").toUpperCase();
  const dIata = String(args.dest_iata ?? trip?.destIata ?? "").toUpperCase();

  let url = "";
  let name = "";
  if (site === "booking") {
    if (!destination) return "Which destination or hotel for Booking.com?";
    const p = new URLSearchParams({ ss: destination, group_adults: String(adults) });
    if (checkin) p.set("checkin", checkin);
    if (checkout) p.set("checkout", checkout);
    url = `https://www.booking.com/searchresults.html?${p.toString()}&nflt=fc%3D2`;
    name = "Booking.com";
  } else if (site === "airbnb") {
    if (!destination) return "Which destination for Airbnb?";
    const p = new URLSearchParams({ adults: String(adults) });
    if (checkin) p.set("checkin", checkin);
    if (checkout) p.set("checkout", checkout);
    url = `https://www.airbnb.com/s/${encodeURIComponent(destination)}/homes?${p.toString()}`;
    name = "Airbnb";
  } else if (site === "google_flights") {
    if (!dIata) return "Which destination airport for Google Flights?";
    url = `https://www.google.com/travel/flights?q=${encodeURIComponent(
      `Flights from ${oIata} to ${dIata} on ${checkin}${checkout ? ` through ${checkout}` : ""} for ${adults} adults`,
    )}`;
    name = "Google Flights";
  } else if (site === "skyscanner") {
    if (!dIata) return "Which destination airport for Skyscanner?";
    const d = (s: string) => s.replaceAll("-", "").slice(2); // YYMMDD
    url = `https://www.skyscanner.net/transport/flights/${oIata.toLowerCase()}/${dIata.toLowerCase()}/${checkin ? d(checkin) : ""}${checkout ? "/" + d(checkout) : ""}/?adults=${adults}`;
    name = "Skyscanner";
  } else return "Which site — booking, airbnb, google_flights or skyscanner?";

  await convexMutation("ui:setPanel", { type: "launch", value: JSON.stringify({ name, url }), title: `launch · ${name}` });
  await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "url", value: url, title: `${name} — prefilled ↗` }).catch(() => {});
  return `${name} is opening PRE-FILLED: ${destination || `${oIata}→${dIata}`}${checkin ? `, ${checkin}` : ""}${checkout ? ` → ${checkout}` : ""}, ${adults} adults. One tap if the popup was blocked.`;
}

// ── Markets: real charts + the analyst brain ────────────────────────────────
async function priceChartTool(args: any): Promise<string> {
  const { resolveAsset, fetchCandles, keyLevels, chartWidget } = await import("./markets");
  const a = resolveAsset(String(args.asset ?? ""));
  if (!a) return `Couldn't resolve "${args.asset}" to a chartable asset.`;
  const interval = ["1h", "4h", "1d", "1w"].includes(String(args.interval)) ? String(args.interval) : "1d";
  const candles = await fetchCandles(a, interval);
  if (candles.length < 30) return `No chart data for ${a.label} on ${interval}.`;
  const levels = keyLevels(candles);
  const w = chartWidget(a, interval, candles, levels);
  await convexMutation("ui:setPanel", { type: "widget", value: JSON.stringify(w), title: `${a.label} · ${interval}` });
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const s50 = w.sma50[w.sma50.length - 1];
  const s200 = w.sma200[w.sma200.length - 1];
  const r = w.rsi[w.rsi.length - 1];
  return (
    `${a.label} chart (${interval}, ${w.unit}) is on screen. Last ${last.toLocaleString("en-US")} (${w.changePct >= 0 ? "+" : ""}${w.changePct}% last bar), ` +
    `${s50 ? `${last > s50 ? "above" : "below"} the 50-SMA, ` : ""}${s200 ? `${last > s200 ? "above" : "below"} the 200-SMA, ` : ""}RSI ${r ?? "n/a"}. ` +
    `Levels: ${levels.map((l) => `${l.kind[0] === "s" ? "S" : "R"} ${l.price.toLocaleString("en-US")}`).join(", ")}. Speak one short line; offer market_analysis for the full read.`
  );
}

async function marketAnalysisTool(args: any): Promise<string> {
  const { resolveAsset, fetchCandles, keyLevels, chartWidget, fetchVix, fetchCryptoFlows, fetchNews, sma, rsi, ANALYST_SYSTEM } =
    await import("./markets");
  const a = resolveAsset(String(args.asset ?? ""));
  if (!a) return `Couldn't resolve "${args.asset}" to an asset.`;
  const interval = ["4h", "1d", "1w"].includes(String(args.interval)) ? String(args.interval) : "1d";
  const serp = process.env.SERPAPI_KEY ?? (await getSecret("serpapi", "SERPAPI_KEY").catch(() => ""));

  const [daily, weekly, vix, flows, news] = await Promise.all([
    fetchCandles(a, interval, 300),
    fetchCandles(a, "1w", 200),
    a.kind === "crypto" ? Promise.resolve(null) : fetchVix(),
    a.kind === "crypto" && a.binance ? fetchCryptoFlows(a.binance) : Promise.resolve(""),
    serp ? fetchNews(`${a.label} ${a.kind === "crypto" ? "crypto" : a.kind}`, serp) : Promise.resolve("news unavailable"),
  ]);
  if (daily.length < 50) return `Not enough data to analyse ${a.label}.`;

  const levels = keyLevels(daily);
  const closes = daily.map((c) => c.c);
  const last = closes[closes.length - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rr = rsi(closes);
  const fmtBars = (cs: any[], n: number) =>
    cs.slice(-n).map((c) => `${new Date(c.t).toISOString().slice(0, 10)} O${c.o} H${c.h} L${c.l} C${c.c} V${Math.round(c.v)}`).join("\n");

  const dossier =
    `ASSET: ${a.label} (${a.kind}, quoted in ${a.binance ? "USDT" : "USD"}) — anchor timeframe ${interval}\n` +
    `ASSET CALIBRATION: ${a.profile}\n\n` +
    `PRICE NOW: ${last} | SMA20 ${s20[s20.length - 1]?.toFixed(2)} | SMA50 ${s50[s50.length - 1]?.toFixed(2)} | SMA200 ${s200[s200.length - 1]?.toFixed(2)} | RSI14 ${rr[rr.length - 1]?.toFixed(1)}\n` +
    `KEY LEVELS (auto-clustered pivots): ${levels.map((l) => `${l.kind} ${l.price} (${l.touches} touches)`).join("; ")}\n` +
    (vix ? `VIX: ${vix.value} — ${vix.regime}\n` : "") +
    (flows ? `CRYPTO FLOWS: ${flows}\n` : "") +
    `\nRECENT ${interval.toUpperCase()} BARS (last 90):\n${fmtBars(daily, 90)}\n` +
    `\nWEEKLY BARS for the big count (last 60):\n${fmtBars(weekly, 60)}\n` +
    `\nNEWS:\n${news}\n` +
    (args.question ? `\nDANIEL'S QUESTION: ${String(args.question)}\n` : "");

  const key = process.env.OPENAI_API_KEY ?? (await getSecret("openai", "OPENAI_API_KEY").catch(() => ""));
  if (!key) return "Analysis core unavailable (no OpenAI key).";
  let analysis = "";
  let lastErr = "";
  // max_output_tokens INCLUDES reasoning tokens on the Responses API — a tight
  // budget gets fully consumed by thinking and returns zero visible text.
  const attempts: [string, string, number][] = [
    ["gpt-5.1", "medium", 75_000],
    ["gpt-5-mini", "medium", 35_000],
  ];
  for (const [model, effort, timeout] of attempts) {
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          instructions: ANALYST_SYSTEM,
          input: dossier,
          reasoning: { effort },
          max_output_tokens: 8000,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) {
        lastErr = `${model}: ${r.status} ${(await r.text()).slice(0, 120)}`;
        continue;
      }
      const j: any = await r.json();
      analysis =
        j.output_text ??
        (Array.isArray(j.output)
          ? j.output.flatMap((o: any) => (Array.isArray(o.content) ? o.content : [])).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("\n")
          : "");
      if (analysis.trim()) break;
      lastErr = `${model}: empty text (status ${j.status ?? "?"}${j.incomplete_details?.reason ? ", " + j.incomplete_details.reason : ""})`;
    } catch (e: any) {
      lastErr = `${model}: ${String(e?.message ?? e).slice(0, 80)}`;
    }
  }
  if (!analysis.trim())
    return `The analysis pass failed (${lastErr}) — show the chart with price_chart and reason from the summary instead.`;

  // annotated chart on the big screen + the full write-up as a tappable card
  const verdictLine = (analysis.match(/## Verdict[\s\S]*?\n([^\n#].{20,240})/i)?.[1] ?? "").trim();
  const w = chartWidget(a, interval, daily, levels, [verdictLine].filter(Boolean));
  await convexMutation("ui:setPanel", { type: "widget", value: JSON.stringify(w), title: `${a.label} · analysis` });
  await convexMutation("chatQueue:postCard", {
    threadId: await activeThread(),
    type: "markdown",
    value: `# ${a.label} — full analysis (${interval})\n\n${analysis}`.slice(0, 3900),
    title: `analysis · ${a.label}`,
  }).catch(() => {});
  return (
    `FULL ANALYSIS (annotated chart is on screen; complete write-up posted as a card — deliver the verdict as your own read, short and direct):\n` +
    analysis.slice(0, 4500)
  );
}

// ── Travel planner: one scout call fans out to the hub's proven providers ──
async function tripPlanTool(args: any): Promise<string> {
  const destination = String(args.destination ?? "").trim();
  const destIata = String(args.dest_iata ?? "").trim();
  const depart = String(args.depart_date ?? "");
  const ret = String(args.return_date ?? "");
  if (!destination || !destIata || !/^\d{4}-\d{2}-\d{2}$/.test(depart) || !/^\d{4}-\d{2}-\d{2}$/.test(ret))
    return "I need destination, its airport code, and both dates (YYYY-MM-DD).";
  const budget = Number(args.budget_total_gbp) || 0;
  if (budget <= 0)
    return "BUDGET MISSING — do NOT search yet. Ask Daniel one short question: what's the total budget for this trip?";
  // Flights are never assumed: he might drive, train it, or already have them.
  if (args.include_flights === undefined && !args.origin_iata)
    return "FLIGHTS UNDECIDED — do NOT search yet. Ask Daniel one short question: should I include flights, and from which airport?";
  if (args.include_flights === true && !args.origin_iata)
    return "ORIGIN MISSING — ask Daniel which airport he's flying from.";
  const { scoutTrip, latestTrip } = await import("./travel");
  // If the globe is already open for this destination, populate THAT doc live
  // instead of spawning a duplicate.
  let reuseId: string | undefined;
  const existing = await latestTrip();
  if (existing && existing.doc.destination.toLowerCase().trim() === destination.toLowerCase().trim()) reuseId = existing.id;
  const { doc } = await scoutTrip({
    destination,
    destIata,
    origin: String(args.origin_iata ?? "LHR"),
    departDate: depart,
    returnDate: ret,
    adults: Math.max(1, Number(args.adults) || 2),
    budgetGbp: budget,
    vibe: args.vibe ? String(args.vibe) : undefined,
    maxPricePerNight: Number(args.max_price_per_night) || undefined,
    vacationRentals: !!args.vacation_rentals,
    includeFlights: args.include_flights !== false,
    reuseId,
  });
  const f = doc.flights[0];
  const cheapStay = doc.stays[0];
  return (
    `Trip planner is live on the globe screen. Found: ${doc.flights.length} flights (best ${f ? `${f.airline} £${f.priceGbp}pp, ${f.stops === 0 ? "direct" : f.stops + " stop"}` : "none"}), ` +
    `${doc.stays.length} stays within budget (e.g. ${cheapStay ? `${cheapStay.name} ★${cheapStay.rating} £${cheapStay.totalGbp} total` : "none"}), ` +
    `${doc.activities.length} activities (top: ${doc.activities.slice(0, 3).map((a) => a.name).join(", ")}). ` +
    `Budget £${budget}. Speak TWO short sentences with the single best flight + stay combo, then ask what he wants to lock in. ` +
    `Use trip_update to lock choices (hotel names: ${doc.stays.slice(0, 6).map((s) => s.name).join(" | ")}).`
  );
}

async function tripUpdateTool(args: any): Promise<string> {
  const { latestTrip, saveTrip, computeTransfer, hubAction } = await import("./travel");
  const t = await latestTrip();
  if (!t) return "No trip on the go — run trip_plan first.";
  const { doc } = t;
  const action = String(args.action ?? "");
  if (action === "show") {
    await saveTrip(t.id, doc);
    return `Trip "${doc.title}" is back on the globe screen.`;
  }
  if (action === "lock_flight") {
    const i = Math.max(1, Number(args.flight_index) || 1) - 1;
    if (!doc.flights[i]) return `Only ${doc.flights.length} flights on the list.`;
    doc.locked.flight = doc.flights[i];
    await saveTrip(t.id, doc);
    const f = doc.locked.flight;
    return `Flight locked: ${f.airline} £${f.priceGbp}pp, ${f.departTime} → ${f.arriveTime}. Running total £${doc.totals?.total}.`;
  }
  if (action === "lock_stay") {
    const q = String(args.stay ?? "").toLowerCase().trim();
    const hit = doc.stays.find((s) => s.name.toLowerCase().includes(q));
    if (!hit)
      return `No stay matches "${args.stay}". Options: ${doc.stays.slice(0, 8).map((s) => s.name).join(" | ")}.`;
    doc.locked.stay = hit;
    doc.transfer = await computeTransfer(doc);
    await saveTrip(t.id, doc);
    return (
      `Locked ${hit.name} (★${hit.rating ?? "?"}, £${hit.totalGbp ?? "?"} total, ${(hit.amenities ?? []).join(", ")}).` +
      (doc.transfer ? ` Airport transfer from the hotel: ${doc.transfer.durationText}, ${doc.transfer.distanceText} by car.` : "") +
      ` Running total £${doc.totals?.total} of £${doc.budgetGbp}.`
    );
  }
  if (action === "toggle_activity") {
    const q = String(args.activity ?? "").toLowerCase().trim();
    const hit = doc.activities.find((a) => a.name.toLowerCase().includes(q));
    if (!hit) return `No activity matches "${args.activity}". Have: ${doc.activities.map((a) => a.name).slice(0, 10).join(" | ")}.`;
    const idx = doc.locked.activities.indexOf(hit.name);
    if (idx >= 0) doc.locked.activities.splice(idx, 1);
    else doc.locked.activities.push(hit.name);
    await saveTrip(t.id, doc);
    return `${idx >= 0 ? "Removed" : "Added"} ${hit.name}${idx >= 0 ? " from" : " to"} the plan (${doc.locked.activities.length} activities picked).`;
  }
  if (action === "set_budget") {
    const b = Number(args.budget_total_gbp) || 0;
    if (b <= 0) return "Give me the new total budget in pounds.";
    doc.budgetGbp = b;
    await saveTrip(t.id, doc);
    return `Budget set to £${b}. Currently at £${doc.totals?.total}.`;
  }
  if (action === "rescout_stays") {
    const res = await hubAction("travelActions:searchStays", {
      query: `${doc.destination} hotels`,
      checkIn: doc.departDate,
      checkOut: doc.returnDate,
      adults: doc.adults,
      maxPricePerNight: Number(args.max_price_per_night) || undefined,
      vacationRentals: !!args.vacation_rentals,
    }).catch(() => ({ options: [] }));
    const stays = (res.options ?? []).filter((s: any) => s.lat && s.lng).slice(0, 24);
    if (!stays.length) return "That search came back empty — loosen the limits.";
    doc.stays = stays;
    await saveTrip(t.id, doc);
    return `Re-scouted: ${stays.length} ${args.vacation_rentals ? "rentals" : "hotels"} now on the globe (top: ${stays.slice(0, 4).map((s: any) => `${s.name} £${s.totalGbp ?? s.priceGbp}`).join(", ")}).`;
  }
  return "Unknown trip action.";
}

async function tripFinalizeTool(args: any): Promise<string> {
  const { latestTrip, saveTrip, computeTransfer, buildItinerary, tripToCalendar, tripToMindmap } = await import("./travel");
  const t = await latestTrip();
  if (!t) return "No trip to finalize — run trip_plan first.";
  const { doc } = t;
  if (!doc.locked.flight && doc.flights[0]) doc.locked.flight = doc.flights[0];
  if (!doc.locked.stay) return "Lock a hotel first (trip_update lock_stay) — the itinerary and transfer hang off it.";
  if (!doc.transfer) doc.transfer = await computeTransfer(doc);
  doc.itinerary = buildItinerary(doc);
  doc.status = "planned";
  await saveTrip(t.id, doc);
  let calNote = "";
  if (args.add_to_calendar !== false) {
    const n = await tripToCalendar(doc, t.id).catch(() => 0);
    calNote = ` ${n} items written to the calendar (they'll show in briefings).`;
  }
  const mapId = await tripToMindmap(doc, t.id).catch(() => "");
  return (
    `Trip locked in: ${doc.itinerary?.length} days planned, total ≈ £${doc.totals?.total} of £${doc.budgetGbp}.` +
    calNote +
    (mapId ? ` Interactive trip map saved to the creations library.` : "") +
    ` The full plan is on screen. Speak one short confident summary.`
  );
}

async function creationsList(args: any): Promise<string> {
  const kind = ["canvas", "chart", "image", "pdf", "doc"].includes(String(args.kind)) ? String(args.kind) : undefined;
  const rows: any[] = (await convexQuery("creations:list", { kind, limit: 30 })) ?? [];
  await convexMutation("ui:setPanel", { type: "creations", value: JSON.stringify({ kind: kind ?? null }), title: "creations library" });
  if (!rows.length) return "The creations library is empty so far — everything I make from now on lands there.";
  return (
    `Creations library is on screen (${rows.length} items). Latest: ` +
    rows.slice(0, 6).map((r) => `${r.kind} "${r.title}"`).join(", ") +
    "."
  );
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
    case "orchestrate": {
      const mission = String(args.mission ?? "").trim();
      const agents = (Array.isArray(args.agents) ? args.agents : []).filter((a: any) => a?.task && a?.label).slice(0, 6);
      if (!mission || agents.length < 2)
        return "A fleet needs a mission and at least 2 independent agent tasks — for one task use dispatch_agent.";
      const missionId = await convexMutation("missions:create", { goal: mission, agentCount: agents.length });
      for (const a of agents) {
        const scaffold = TASK_TEMPLATES[String(a.template ?? "")] ?? "";
        await convexMutation("jobs:enqueue", {
          task: `${String(a.task).slice(0, 2000)}${scaffold}\n\n(You are one agent of a ${agents.length}-agent fleet on the mission: "${mission}". Do ONLY your workstream.)`,
          repo: a.repo ? String(a.repo) : undefined,
          model: ["haiku", "sonnet", "opus"].includes(a.model) ? String(a.model) : undefined,
          missionId: String(missionId),
          label: String(a.label).slice(0, 60),
        });
      }
      await convexMutation("ui:setPanel", { type: "fleet", value: JSON.stringify({ missionId: String(missionId) }), title: `mission · ${mission.slice(0, 44)}` }).catch(() => {});
      return `Fleet of ${agents.length} dispatched on "${mission}" (${agents.map((a: any) => a.label).join(", ")}). Live fleet view is on screen; the synthesized report lands here when the last agent finishes. Tell Daniel in one casual line.`;
    }
    case "show": {
      let { kind, value, title } = args as { kind?: string; value: string; title?: string };
      value = String(value ?? "").trim();
      if (!value) return "Nothing to show — give me a url, image, code or text.";
      // Models omit/confuse `kind` — infer and normalize so it always renders.
      const id = YT_ID(value);
      if (id) {
        kind = "video";
        // jsapi enabled so video_control can drive it; autoplay when he asked to play
        value = `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0${args.play ? "&autoplay=1" : ""}`;
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
    case "video_control": {
      const action = ["play", "pause", "close"].includes(String(args.action)) ? String(args.action) : "";
      if (!action) return "play, pause or close?";
      await convexMutation("ui:setVideoCmd", { cmd: action });
      return action === "close" ? "Video closed." : `Video ${action === "play" ? "playing" : "paused"}.`;
    }
    case "open_travel_site":
      return await openTravelSite(args);
    case "web_search":
      return await webSearch(String(args.query));
    case "flight_search":
      return await flightSearch(args);
    case "rentals_calendar":
      return await rentalsCalendar(args);
    case "rental_availability":
      return await rentalAvailability(args);
    case "rental_stats":
      return await rentalStats();
    case "weather":
      return await weatherWidget(args);
    case "market":
      return await marketWidget(args);
    case "timer":
      return await timerWidget(args);
    case "briefing":
      return await briefingWidget();
    case "todo_add":
      return await todoAdd(args);
    case "todo_done":
      return await todoDone(args);
    case "todo_remove":
      return await todoRemove(args);
    case "calendar_add":
      return await calendarAdd(args);
    case "calendar_remove":
      return await calendarRemove(args);
    case "calendar_view":
      return await calendarView(args);
    case "open_app":
      return await openApp(args);
    case "research":
      return await researchTool(args);
    case "deliberate":
      return await deliberateTool(args);
    case "create_image":
      return await createImage(args);
    case "store_image":
      return await storeImage(args);
    case "create_pdf":
      return await createPdf(args);
    case "board":
      return await boardTool(args);
    case "mind_map":
      return await mindMap(args);
    case "chart":
      return await chartTool(args);
    case "price_chart":
      return await priceChartTool(args);
    case "market_analysis":
      return await marketAnalysisTool(args);
    case "trip_open": {
      const { openTrip } = await import("./travel");
      const destination = String(args.destination ?? "").trim();
      if (!destination) return "Which destination?";
      const { doc } = await openTrip({ destination, destIata: args.dest_iata ? String(args.dest_iata) : undefined });
      return `Globe is up, centred on ${destination}${doc.airport ? ` (${doc.airport.name} marked)` : ""} — it fills in live as you plan. Now get budget + dates from Daniel, then trip_plan populates it.`;
    }
    case "trip_plan":
      return await tripPlanTool(args);
    case "trip_update":
      return await tripUpdateTool(args);
    case "trip_finalize":
      return await tripFinalizeTool(args);
    case "creations_list":
      return await creationsList(args);
    case "orb_mood": {
      const mood = ["calm", "focused", "dreamy", "warm", "serious", "alert", "excited"].includes(String(args.mood)) ? String(args.mood) : "calm";
      await convexMutation("ui:setMood", { mood });
      return `Mood set: ${mood}. (Say nothing about it — it just happens.)`;
    }
    case "news_today":
      return await newsToday(args);
    case "music_search":
      return await musicSearch(args);
    case "transport_route":
      return await transportRoute(args);
    case "memory_map":
      return await memoryMapTool(args);
    case "shop_search":
      return await shopSearch(args);
    case "todo_list": {
      const todos: any[] = (await q_hub("todos:list")) ?? [];
      const open = todos.filter((t: any) => !t.done).slice(0, 24);
      await showWidget(
        {
          kind: "todos",
          label: `to-dos · ${open.length} open`,
          items: open.map((t: any) => ({
            text: String(t.text).slice(0, 120),
            due: t.dueDate ? londonDateStr(t.dueDate) : null,
            tags: (t.tags ?? []).slice(0, 3),
          })),
        },
        "to-do list",
      );
      return `Tickable to-do list is on screen (${open.length} open). Speak one line — maybe which one you'd tackle first.`;
    }
    case "net_worth": {
      const w: any = await q_hub("wealth:getWealth");
      if (!w) return "Couldn't reach the wealth data.";
      const cats = Object.entries(w.byCategory ?? {}).map(([k, v]: [string, any]) => ({
        label: k,
        value: Math.round((v.assets ?? []).reduce((a: number, x: any) => a + (x.lastValueGBP ?? 0), 0)),
        note: `${(v.assets ?? []).length} assets`,
      })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
      await showWidget(
        {
          kind: "stats",
          title: "Net worth",
          kpis: [
            { label: "net worth", value: Math.round(w.currentTotalGBP ?? 0), prefix: "£" },
            { label: "cashflow /mo", value: Math.round(w.netCashflowGbp ?? 0), prefix: "£" },
            { label: "expenses /mo", value: Math.round(w.expensesMonthlyGbp ?? 0), prefix: "£" },
            { label: "rental (mo)", value: Math.round(w.confirmedRentalGbp ?? 0), prefix: "£" },
          ],
          bars: cats,
          barsLabel: "by category £",
        },
        "net worth",
      );
      return `Net worth dashboard on screen: £${Math.round(w.currentTotalGBP ?? 0).toLocaleString("en-GB")} across ${w.assetCount} assets, top category ${cats[0]?.label}. One-line takeaway only.`;
    }
    case "plan_my_day":
      return await planMyDay(args);
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
      const project = args.project ? String(args.project).slice(0, 50) : undefined;
      await convexMutation("memory:write", {
        kind: String(args.kind ?? "fact"),
        title: String(args.title).slice(0, 120),
        body: String(args.body).slice(0, 1200),
        tags: [...(Array.isArray(args.tags) ? args.tags.map(String) : []), ...(project ? [project] : [])].slice(0, 6),
      });
      const { vaultWrite } = await import("./obsidian");
      await vaultWrite(String(args.kind ?? "fact"), String(args.title), String(args.body), project);
      return project ? `Saved to memory (filed under project ${project}).` : "Saved to memory.";
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
      const [active, recent, missions] = await Promise.all([
        convexQuery("jobs:active", {}),
        convexQuery("findings:recent", { limit: 4 }),
        convexQuery("missions:active", {}).catch(() => []),
      ]);
      const m = Array.isArray(missions) && missions.length
        ? "Missions: " +
          missions
            .map((x: any) => `"${x.goal.slice(0, 60)}" [${x.status}] ${x.jobs.filter((j: any) => j.status === "done").length}/${x.jobs.length} agents done`)
            .join("; ") + "\n"
        : "";
      const a = Array.isArray(active) && active.length
        ? "Running: " + active.map((j: any) => `"${(j.label ?? j.task).slice(0, 70)}" — ${j.progress || j.status}`).join("; ")
        : "No agents running.";
      const f = Array.isArray(recent) && recent.length
        ? "\nRecent findings: " + recent.map((r: any) => r.spoken).join(" | ")
        : "";
      return m + a + f;
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
