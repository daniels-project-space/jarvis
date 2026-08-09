import "server-only";
import { convexMutation, convexQuery } from "./context";
import { getSecret, getServiceSecrets } from "./vault";
import { r2Put, r2StoreFromUrl } from "./r2";
import type { ManagedMission } from "../mastra/supervisor";
import { withAdminSession } from "./control-context";
import { wakeAgentFleet } from "./agent-fleet-dispatch";
import { cloudProviderAdmissionReadiness } from "./cloud-provider-admission";
import { SHALLOW_PROVENANCE_RULE } from "./git-delivery";
import { workModelLabel, workModelPriority } from "./work-models";
import { exactTextWorkOrder } from "./work-order";
import { findHostApp, type JarvisHostAction, type JarvisHostActionName } from "./host-actions";
import { createICloudEvent, deleteICloudEvent, findICloudEvents, listICloudEvents } from "./icloud-calendar";
import { lookupGmailBookingsReadOnly, scanGmailBookingConfirmations, type ConfirmedBooking } from "./booking-email";
import { resolveProjectSourceAdmission } from "./source-admission-server";
import { isSafeSourceBranch, type ProjectSourceAdmission } from "./source-admission";
import { canonicalizeRepository } from "./workflow-contract";
import { admissionMutationName, v2AdmissionEnabled } from "./mission-protocol-rollout";
import {
  normalizeToolInvocationContext,
  type ToolExecutionHostContext,
  type ToolInvocationContext,
} from "./tool-invocation-context";
import { startSupervisedOrchestrationIfSelected } from "./mission-supervisor-orchestration";
import {
  VISUAL_BLOCK_KINDS,
  VISUAL_CAPABILITIES,
  mergeVisualScene,
  parseVisualSceneJson,
  type VisualScene,
} from "./visual-scene";
import {
  googleDirectionsUrl,
  googlePlacesSearchBody,
  googlePlacesTextQuery,
  normalizeTravelMapRequest,
  orderTravelMapPoints,
  type TravelMapPoint,
} from "./travel-map";

// JARVIS's tool belt — one portable JSON-schema definition list executed by
// the foreground Codex supervisor and the realtime client bridge.

export const TOOL_DEFS = [
  {
    name: "dispatch_agent",
    description:
      "Delegate durable work to JARVIS's permanent team. The same specialist can own multiple concurrent jobs, so dispatch a follow-up without pausing earlier work and link it with parent_job_id when known. The manager chooses Paul (development), Atlas (research/strategy), Iris (creative), Maya (travel), or Sentry (reliability), selects Luna/Terra/Sol intelligence, binds it to this conversation, and returns immediately. Work can checkpoint and continue for hours or days. Verified code changes in Daniel's repositories are merged automatically by the delivery controller; only protected external actions wait for Daniel. Do not delegate quick lookups.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear, self-contained task including all context the agent needs (URLs, video IDs, what to find out)" },
        repo: { type: "string", description: "owner/repo or short name if the task is about a specific repo, else omit" },
        model: { type: "string", enum: ["luna", "terra", "sol"], description: "Terra for research/summaries/normal code (default), Sol for hard multi-file engineering or consequential reasoning, Luna for bounded lookups" },
        agent_id: { type: "string", enum: ["paul", "atlas", "iris", "maya", "sentry"], description: "Optional permanent specialist; omit to let JARVIS route it" },
        parent_job_id: { type: "string", description: "Optional earlier job this follow-up extends. The follow-up starts independently and does not wait for the parent." },
        readonly: { type: "boolean", description: "Force a read-only run" },
        acceptance_criteria: { type: "array", items: { type: "string" }, description: "What must be demonstrably true before this is complete" },
        mcp: { type: "array", items: { type: "string", enum: ["playwright", "context7"] }, description: "Optional MCP servers: playwright for live browser automation, context7 for library docs" },
      },
      required: ["task"],
    },
  },
  {
    name: "orchestrate",
    description:
      "Ask the Mastra JARVIS supervisor to plan and run a durable mission with the permanent team. You may supply 2-6 genuinely independent workstreams, or omit them and let the supervisor consult specialists and decompose the goal. Independent Trigger workers run pinned subscription Codex CLI sessions with repository-scoped tools; Trigger Realtime streams activity while Convex preserves checkpoints, automatic delivery and protected external decisions. One coherent reviewed result returns to the originating conversation.",
    parameters: {
      type: "object",
      properties: {
        mission: { type: "string", description: "the overall goal in one sentence" },
        repo: { type: "string", description: "optional primary repo when the supervisor should plan the workstreams" },
        context: { type: "string", description: "important conversation/project context the supervisor must preserve" },
        acceptance_criteria: { type: "array", items: { type: "string" }, description: "mission-level definition of done" },
        agents: {
          type: "array",
          description: "2-6 independent workstreams",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "3-5 word fleet-view label" },
              task: { type: "string", description: "fully self-contained task incl. all context (agents start blank)" },
              repo: { type: "string", description: "owner/repo if it works on code" },
              model: { type: "string", enum: ["luna", "terra", "sol"] },
              agent_id: { type: "string", enum: ["paul", "atlas", "iris", "maya", "sentry"] },
              readonly: { type: "boolean" },
              acceptance_criteria: { type: "array", items: { type: "string" } },
              template: { type: "string", enum: ["research_report", "bug_fix", "feature_add", "refactor", "landing_page", "api_integration"], description: "method scaffold to enforce" },
            },
            required: ["label", "task"],
          },
        },
      },
      required: ["mission"],
    },
  },
  {
    name: "goal_mode",
    description:
      "Start or control one durable long-running outcome. Goal Mode uses one Sol/max architecture session, 2-8 dependency-aware Terra/high build sessions with persistent checkpoints, then Sol/max deep validation and bounded repair waves. It routes new apps through App Factory, video work through YouTube Studio AI, existing products into their own repo, and genuinely new infrastructure through Daniel's isolated cloud standard. Use for outcomes that may take hours or days; use orchestrate for a short parallel fleet.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "pause", "resume", "cancel", "steer"] },
        goal: { type: "string", description: "Concrete observable outcome; required for start" },
        mission_id: { type: "string", description: "Goal Mode mission id; required for pause/resume/cancel and optional for status" },
        input: { type: "string", description: "Steering instruction when action=steer; preserves accepted node scope and creates fresh execution generations" },
        repo: { type: "string", description: "Known owner/repo only when the goal explicitly belongs there" },
        source_branch: { type: "string", description: "Exact existing GitHub branch to seal as the v2 mission source; start only" },
        acceptance_criteria: { type: "array", items: { type: "string" }, description: "Observable goal-level truths the final Sol validator must prove" },
        build_sessions: { type: "number", description: "Maximum bounded Terra/high implementation sessions, 2-8; default 6" },
        revision_waves: { type: "number", description: "Maximum automatic Terra repair waves after final validation, 1-4; default 2" },
      },
      required: ["action"],
    },
  },
  {
    name: "work_control",
    description:
      "Control a durable team job shown in the command deck: approve or decline consequential work, steer/pause/resume/cancel active work, or retry a failed job. Steering checkpoints the current attempt into a fresh scoped session.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id from team_status/command deck" },
        action: { type: "string", enum: ["approve", "decline", "pause", "resume", "cancel", "retry", "answer", "steer"] },
        input: { type: "string", description: "Daniel's answer when action=answer, or new instruction when action=steer" },
      },
      required: ["job_id", "action"],
    },
  },
  {
    name: "creative_sprint",
    description:
      "Run a structured creative sprint when Daniel wants deeper brainstorming plus a visual result. Atlas develops distinct, evidence-aware directions and Iris turns the strongest directions into an illustration/diagram/storyboard brief. Results arrive as one reviewed mission, not a pile of disconnected ideas.",
    parameters: {
      type: "object",
      properties: {
        brief: { type: "string", description: "The challenge, audience, constraints and desired output" },
        output: { type: "string", enum: ["illustration", "diagram", "storyboard", "visual_system", "brainstorm" ] },
      },
      required: ["brief", "output"],
    },
  },
  {
    name: "visual_scene",
    description:
      "Compose or edit a beautiful live visual workspace while talking: dashboards, choices, KPI tiles, progress, charts, heatmaps, tables, comparisons, timelines, Gantt, kanban, funnels, decision matrices, camera-driven graphs/maps, galleries, link grids, activity streams and trusted live app snapshots. Proactively use it when structured conversation is clearer visually, keep one scene per topic, and patch stable block ids as the conversation evolves. Live facts must use an allowlisted source; inline data is composed conversation content, never label it live.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "show", "focus"] },
        scene_id: { type: "string", description: "creation id from the prior tool result; omit to use the latest visual scene" },
        title: { type: "string" },
        subtitle: { type: "string" },
        project: { type: "string", description: "known project this belongs to; omit when it is an ad-hoc inquiry" },
        inquiry: { type: "string", description: "short stable topic when this is not tied to a known project" },
        capability: { type: "string", enum: [...VISUAL_CAPABILITIES], description: "Optional ready-made live workspace. Custom blocks may be supplied as well." },
        layout: { type: "string", enum: ["dense", "roomy"] },
        focus_block_id: { type: ["string", "null"], description: "focus/highlight a stable block id; null clears focus" },
        remove: { type: "array", items: { type: "string" }, description: "stable block ids to remove during update" },
        blocks: {
          type: "array",
          maxItems: 24,
          description: "Blocks to create or upsert by stable id. For bound app data set source; otherwise pass inline items/series/rows/nodes/edges.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: [...VISUAL_BLOCK_KINDS] },
              title: { type: "string" },
              subtitle: { type: "string" },
              span: { type: "string", enum: ["one", "two", "full"] },
              tone: { type: "string", enum: ["cyan", "green", "amber", "red", "purple", "blue", "slate"] },
              source: {
                type: "string",
                enum: ["projects", "agents", "attention", "watches", "findings", "reminders", "business:rental", "business:youtube", "business:wealth", "business:music", "business:ads"],
              },
              prefix: { type: "string" }, suffix: { type: "string" }, unit: { type: "string" },
              min: { type: "number" }, max: { type: "number" },
              labels: { type: "array", items: { type: "string" } },
              columns: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } },
              items: { type: "array", items: { type: "object", additionalProperties: true } },
              series: { type: "array", items: { type: "object", additionalProperties: true } },
              nodes: { type: "array", items: { type: "object", additionalProperties: true } },
              edges: { type: "array", items: { type: "object", additionalProperties: true } },
              grid: {
                type: "object",
                description: "Optional 12-column starting position; Daniel can rearrange it later.",
                properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
                required: ["x", "y", "w", "h"],
              },
            },
            required: ["id", "kind"],
          },
        },
      },
      required: ["action"],
    },
  },
  {
    name: "show",
    description:
      "Put one thing on Daniel's screen while you talk: a webpage, YouTube video, image, code, notes, or a structured list. Use kind=list for steps, checklists, grouped choices or any response with several parallel items; never flatten those into markdown. For richer multi-module work use visual_scene. Videos render 16:9 and shrink to picture-in-picture when he keeps talking.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["url", "video", "image", "code", "markdown", "list"] },
        value: { type: "string", description: "Required except for list: URL / YouTube link or ID / image URL / code / markdown" },
        title: { type: "string", description: "Short label shown above the panel" },
        subtitle: { type: "string", description: "List only: one-line context" },
        ordered: { type: "boolean", description: "List only: show step numbers" },
        items: {
          type: "array",
          description: "List only: structured, individually selectable rows",
          items: {
            type: "object",
            properties: {
              id: { type: "string" }, label: { type: "string" }, detail: { type: "string" },
              status: { type: "string" }, value: { type: ["string", "number"] }, icon: { type: "string" },
              group: { type: "string" }, href: { type: "string" }, checked: { type: "boolean" },
            },
            required: ["label"],
          },
        },
        play: { type: "boolean", description: "video only: start playback immediately" },
      },
      required: ["kind"],
    },
  },
  {
    name: "show_ranking",
    description:
      "Put a RANKED LIST of named things on Daniel's screen as portrait tiles — a photo, rank number and name for each (worst leaders in history, best sci-fi films, richest people, tallest mountains, greatest strikers, biggest companies…). ALWAYS reach for this instead of reading a ranked / top-N / 'best|worst X' list aloud: pass the items ALREADY in rank order and I fetch each portrait automatically. Then speak only a one-line topper, never the whole list.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "e.g. 'Worst leaders in history'" },
        items: {
          type: "array",
          description: "already in rank order (1 = top of the list); 3–8 items",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "the entity — a real, searchable proper name (person / place / film / thing)" },
              note: { type: "string", description: "optional ≤6-word tag, e.g. 'USSR · ~20M deaths' or '1972 · Coppola'" },
            },
            required: ["name"],
          },
        },
      },
      required: ["title", "items"],
    },
  },
  {
    name: "rank_focus",
    description:
      "Highlight ONE tile in the ranking/portrait overlay ALREADY on screen — it pulses and its bio expands. Use the MOMENT Daniel asks about a specific one ('tell me about number 3', 'who's the second', 'more on him', 'the last guy'). Pass the rank number. Optionally pass a richer `bio` (1-2 sentences) to fill that tile. Then speak about just that one. This is how ranking overlays get explored without rebuilding them.",
    parameters: {
      type: "object",
      properties: {
        index: { type: "number", description: "the rank number to highlight (1 = top of the list)" },
        bio: { type: "string", description: "optional: a richer 1-2 sentence bio to show under that tile" },
      },
      required: ["index"],
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
  { name: "hide", description: "Close the current on-screen overlay/panel — call when Daniel says close/hide it, or when the conversation has clearly moved on from what's showing.", parameters: { type: "object", properties: {} } },
  {
    name: "web_search",
    description:
      "Fast web search — the full result list automatically appears on Daniel's screen; you speak the one-line takeaway. Use this (not dispatch_agent) for anything findable in one search: prices, hotels, news, facts.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "flight_search",
    description:
      "Live flight search (Google Flights) — full results with prices/times appear on Daniel's screen instantly; speak only the best option. Use for standalone flight questions OUTSIDE trip planning (trips: trip_plan owns flights), never dispatch_agent.",
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
    name: "project_goal",
    description:
      "Read or update a durable project outcome so Jarvis connects conversations, agent work and suggestions to what each app is actually for. Use review to show the live portfolio; use upsert/advance/block/achieve only when Daniel states a goal, a real result lands, or evidence changes its status. Do not turn casual ideas into commitments.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["review", "upsert", "advance", "block", "achieve"] },
        project: { type: "string", description: "canonical project slug" },
        title: { type: "string" },
        outcome: { type: "string", description: "observable definition of success; required for a new goal" },
        priority: { type: "number", description: "0-100" },
        progress: { type: "number", description: "0-100, based on evidence" },
        next_action: { type: "string" },
        blocked_by: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        owner: { type: "string", description: "Daniel, Jarvis, or permanent specialist" },
      },
      required: ["action"],
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
    name: "remind_at",
    description:
      "Set a TIMED reminder that fires at a specific moment (push notification + JARVIS says it aloud): 'remind me at 7pm to call mum', 'in 20 minutes check the oven'. Compute the exact time yourself and pass at_iso (Europe/London local intent). For list items without a time, use todo_add instead. Never claim a reminder is set without calling this.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "what to remind, e.g. 'call mum'" },
        at_iso: { type: "string", description: "ISO 8601 datetime with offset, e.g. 2026-07-13T19:00:00+01:00" },
        in_minutes: { type: "number", description: "alternative: minutes from now" },
      },
      required: ["text"],
    },
  },
  {
    name: "reminder_cancel",
    description: "Cancel a pending timed reminder by matching its text ('cancel the mum reminder').",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
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
      "ACTUALLY add an event, schedule or calendar reminder to Daniel's live iCloud Calendar. Use for ANY 'put X in my calendar / schedule / I have a meeting'. Never claim an event was added without calling this. Times are Europe/London.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM 24h; omit for an all-day event" },
        end_time: { type: "string", description: "HH:MM if he gave one" },
        location: { type: "string" },
        notes: { type: "string" },
        reminder_minutes_before: { type: "number", description: "Optional iCloud Calendar alert, in minutes before the event" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "calendar_remove",
    description: "Delete an event from Daniel's live iCloud Calendar. Pass a few words from its title.",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    name: "calendar_view",
    description:
      "Read Daniel's live iCloud Calendar and show it as a beautiful visual widget, merged with legacy hub events and rental pickups/returns, as a day plan, week, or month view. Use for 'what's my day/week/month look like', 'show my calendar', 'what's on Friday'.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["day", "week", "month"], description: "default week" },
        date: { type: "string", description: "YYYY-MM-DD anchor, default today" },
      },
    },
  },
  {
    name: "bookings_lookup",
    description:
      "Read Daniel's connected Gmail for confirmed travel bookings without changing Gmail, Calendar, trips, or any external state. Use proactively when an address, hotel base, check-in/out, confirmation, or itinerary should come from his email. Prefer this over bookings_check unless Daniel explicitly asks to import/sync confirmations into Calendar.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back to scan, 7-730 days; default 365" },
        query: { type: "string", description: "Optional destination, property, provider, or booking reference to narrow Gmail lookup" },
        max_results: { type: "number", description: "Maximum confirmation messages to inspect, 1-40; default 20" },
      },
    },
  },
  {
    name: "bookings_check",
    description:
      "Compatibility path for explicitly importing confirmed Gmail bookings into Daniel's iCloud Calendar or an existing trip. This can write calendar/trip data and defaults to calendar sync for backward compatibility. For checking bookings, finding his hotel/address, or proactive travel planning without writes, use bookings_lookup instead. Gmail itself is always read-only.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "How far back to scan, 7-730 days; default 365" },
        trip_id: { type: "string", description: "Optional visible trip creation id to enrich with matching confirmed bookings" },
        sync_calendar: { type: "boolean", description: "Default true: create de-duplicated iCloud Calendar entries for confirmed bookings with a date" },
      },
    },
  },
  {
    name: "open_app",
    description:
      "Actually launch one of Daniel's own apps. In an embedded Hub session this navigates the host page; in the main Jarvis app it also shows a launch card. Use for ANY 'open/launch/pull up <app>'.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "app name as Daniel said it, e.g. 'rental manager'" },
        expected_url: { type: "string", description: "When embedded, copy the current context URL so only that host navigates" },
        host_id: { type: "string", description: "When embedded, copy hostId from JARVIS_HOST_CONTEXT so only that browser tab acts" },
      },
      required: ["app"],
    },
  },
  {
    name: "host_ui",
    description:
      "Act on the real app page surrounding the Jarvis embed. Use only when JARVIS_HOST_CONTEXT is present: show_widget scrolls/reveals a dashboard widget, focus highlights a visible element, activate opens a button/menu, navigate changes a same-origin route, and edit starts visual element selection that returns an exact DOM/source target for an engineer. Never claim a host-page action without this tool.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show_widget", "focus", "activate", "navigate", "edit"] },
        target: { type: "string", description: "Exact id/label from host context, a widget name, or a same-origin route" },
        instruction: { type: "string", description: "For edit: Daniel's requested change shown while he selects the element" },
        expected_url: { type: "string", description: "Current host URL copied from JARVIS_HOST_CONTEXT; prevents acting on a different tab/page" },
        host_id: { type: "string", description: "Exact hostId copied from JARVIS_HOST_CONTEXT; scopes the action to this browser tab" },
      },
      required: ["action", "expected_url", "host_id"],
    },
  },
  {
    name: "mac_shortcut",
    description:
      "Prepare a named Apple Shortcut for Daniel to run locally on his Mac. Use only when he explicitly asks for a Mac-local action and the action maps to a Shortcut he has installed. This never executes automatically: it shows an approval card Daniel must click.",
    parameters: {
      type: "object",
      properties: {
        shortcut: { type: "string", description: "Exact installed Apple Shortcut name, e.g. Add to Notes" },
        input: { type: "string", description: "Text input passed to that Shortcut" },
        reason: { type: "string", description: "Short plain-language description of what it will do" },
      },
      required: ["shortcut"],
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
        project: { type: "string", description: "known project this belongs to" },
        inquiry: { type: "string", description: "short stable topic when not tied to a project" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "store_image",
    description: "Save any image URL permanently into Daniel's creations library (re-hosted on his own storage).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        project: { type: "string" },
        inquiry: { type: "string" },
      },
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
        project: { type: "string" },
        inquiry: { type: "string", description: "short stable topic when not tied to a project" },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: "board",
    description:
      "JARVIS's LIVE VISUAL WORKSPACE — a persistent Excalidraw canvas with semantic nodes, categories, relationships, timeline order, visual prompts, images, sticky notes, shapes, tables and arrows. PROACTIVELY use it when a conversation is spatial or visual (film/worldbuilding, brainstorming, scavenger hunts, plans). For creative speech use action=capture and MULTI-LABEL EXTRACTION: decompose one sentence into every category it establishes, never choose just one. Example: 'Anna sits on a hill behind her house' creates linked character=Anna, location=hill/behind Anna's house, plot=Anna sits on hill, timeline=that beat, and visual=a renderable composition prompt. Preserve the original sentence in source_text. Mark deductions certainty=inferred and unknowns certainty=question; never invent facts. If the scene is visually central or Daniel asks to render it, call create_image and attach its URL to the visual/timeline capture. Stable ids let later captures update concepts instead of duplicating them. template=scavenger remains grounded in Daniel's confirmed choices/clues. update/remove rewrite existing freeform items. Daniel can rearrange, draw, edit and export by hand.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "capture", "add", "update", "remove", "show"] },
        match: { type: "string", description: "update/remove: a few words from the EXISTING item's text" },
        title: { type: "string", description: "board title (create/show)" },
        template: { type: "string", enum: ["film", "scavenger", "blank"], description: "create only; scavenger has choices/clues/route/tasks/notes zones" },
        project: { type: "string", description: "project slug this board belongs to (memory filing), e.g. 'island-script'" },
        inquiry: { type: "string", description: "short stable topic when this is not a named project" },
        source_text: {
          type: "string",
          description: "capture only — Daniel's original sentence or paragraph, preserved as provenance for all extracted nodes",
        },
        captures: {
          type: "array",
          description:
            "capture only — all semantic facts established by source_text. Emit MULTIPLE linked entries when one sentence spans character/location/plot/timeline/visual/etc.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "stable concept slug; reuse it to update the same concept later" },
              category: {
                type: "string",
                enum: ["character", "location", "plot", "timeline", "visual", "relationship", "theme", "object", "question", "note"],
              },
              title: { type: "string", description: "short visible node title" },
              detail: { type: "string", description: "grounded detail from the source, plus clearly marked implications only" },
              related_ids: { type: "array", items: { type: "string" }, description: "ids this node connects to" },
              sequence: { type: "number", description: "timeline order when known; omit when unknown" },
              image_prompt: { type: "string", description: "visual composition ready for create_image; include only grounded visual details" },
              image_url: { type: "string", description: "rendered/reference image URL to attach to this node and moodboard" },
              certainty: { type: "string", enum: ["stated", "inferred", "question"] },
            },
            required: ["id", "category", "title"],
          },
        },
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
      "QUICK node-and-edge diagram (concept maps, structures, relationships) — for rich creative workspaces (moodboards, tables, images, film planning) use board instead. Live-editable on screen while you talk. Saved automatically in the creations library. action=create starts fresh; update edits the one on screen (upserts nodes by id, adds edges, removes by id); show re-opens a saved one by title.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "show"] },
        title: { type: "string", description: "map title (create/show)" },
        project: { type: "string" },
        inquiry: { type: "string", description: "short stable topic when not tied to a project" },
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
        project: { type: "string" },
        inquiry: { type: "string", description: "short stable topic when not tied to a project" },
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
        trip_id: { type: "string", description: "creation id returned by trip_open; use it to populate the exact visible draft" },
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
        trip_id: { type: "string", description: "exact trip creation id shown in context/on the trip workspace" },
        action: { type: "string", enum: ["lock_flight", "lock_stay", "toggle_activity", "set_budget", "rescout_stays", "show"] },
        flight_index: { type: "number", description: "which flight from the list (1-based) for lock_flight" },
        stay: { type: "string", description: "hotel name (or fragment) for lock_stay" },
        activity: { type: "string", description: "activity name (or fragment) for toggle_activity" },
        budget_total_gbp: { type: "number" },
        max_price_per_night: { type: "number", description: "for rescout_stays" },
        vacation_rentals: { type: "boolean", description: "for rescout_stays" },
      },
      required: ["trip_id", "action"],
    },
  },
  {
    name: "trip_finalize",
    description:
      "Lock the reviewed plan in: builds the day-by-day itinerary (flight, airport transfer with real drive time, check-in, activities), optionally syncs it to Daniel's calendar only after an explicit choice, and saves the trip as an interactive connected-node map. Never infer calendar consent.",
    parameters: {
      type: "object",
      properties: {
        trip_id: { type: "string", description: "exact trip creation id" },
        add_to_calendar: { type: "boolean", description: "explicit choice; true syncs idempotently, false leaves Daniel's calendar untouched" },
      },
      required: ["trip_id", "add_to_calendar"],
    },
  },
  {
    name: "creations_list",
    description: "Open Daniel's organised saved-work library on screen—projects and inquiry folders containing boards, visual workspaces, mind maps, charts, images, PDFs, notes, emails, documents and travel plans. Every item can be reopened and downloaded.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["board", "scene", "canvas", "chart", "image", "pdf", "doc", "trip"], description: "filter, optional" },
        folder: { type: "string", description: "folder label to open, optional" },
      },
    },
  },
  {
    name: "draft",
    description:
      "LIVE WRITING DESK: put a text draft (email, message, post, script, caption...) on screen as a clean document. Use for ANY 'help me write / draft / reword X'. Call again with the FULL revised text after each change Daniel asks for — the document updates live so you two can discuss it. Never paste the draft into chat; it lives on the panel. Same title = same document.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "short stable name, e.g. 'Email to Hygglo support'" },
        content: { type: "string", description: "the complete current draft text (markdown ok) — full replacement each call" },
        document_type: { type: "string", enum: ["email", "note", "document", "message", "script"], description: "used to file the draft in the right library category" },
        project: { type: "string" },
        inquiry: { type: "string", description: "short stable topic when not tied to a project" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "price_watch",
    description:
      "Create a durable UK product hunt. It tracks one verified matching listing/product identity with landed-price provenance and pings once on a real target crossing or a meaningful new low. Use for 'find an RS 3 Pro under £400' or 'tell me when X gets cheaper'. It never buys automatically.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "the specific brand/model/variant to track" },
        target_gbp: { type: "number", description: "optional: alert when it falls below this price" },
        condition: { type: "string", enum: ["new", "used", "any"], description: "required product condition if stated" },
      },
      required: ["query"],
    },
  },
  {
    name: "price_alert",
    description:
      "Create a durable asset threshold shown on its chart and notify Daniel only on a genuine below/above crossing. Crypto uses official Binance spot data; equities use Finnhub when connected and an explicitly labelled unofficial fallback otherwise. Informational only — never trades.",
    parameters: {
      type: "object",
      properties: {
        asset: { type: "string", description: "BTC, ETH, SOL, AAPL, TSLA, etc." },
        operator: { type: "string", enum: ["above", "below"] },
        threshold: { type: "number" },
        interval: { type: "string", enum: ["1m", "5m", "1h", "4h", "1d", "1w"] },
        currency: { type: "string", description: "default USDT for crypto, USD otherwise" },
      },
      required: ["asset", "operator", "threshold"],
    },
  },
  {
    name: "watch_list",
    description: "Show active product hunts, chart thresholds and newly hit signals as a live glowing visual workspace.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "watch_cancel",
    description: "Cancel an active product hunt or asset threshold by matching its label.",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
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
      "Shift the orb's colour to match the emotional register of the conversation — it fades in slowly and holds. Set it whenever the tone genuinely moves, matched to who you are being right now: calm (green, easy default), focused (blue, work/markets), dreamy (purple, creative/vision), warm (amber, personal/friendly), tender (soft pink, when he is vulnerable or you are being gentle), playful (magenta, banter/fun), curious (teal, digging into an idea together), serious (steel, hard truths/money), alert (red, problems), excited (bright pink, wins/big moments). Let it breathe with the talk — not every message, but do not be shy either.",
    parameters: {
      type: "object",
      properties: { mood: { type: "string", enum: ["calm", "focused", "dreamy", "warm", "tender", "playful", "curious", "serious", "alert", "excited"] } },
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
    name: "travel_map",
    description:
      "Show a real interactive city/local MapLibre map whenever Daniel asks to see places, attractions, waypoints, a route, or an itinerary. Works for an explicit location anywhere in the world or his saved current location; never assume the UK. Pass his exact taste in preferences (including niche/non-touristy follow-ups) instead of reducing it to a fixed category. For route/itinerary requests, include_bookings defaults on so a matching read-only Gmail hotel booking can become the labelled starting base; no Calendar or Gmail state is changed. The panel shows honest centre/base labels, numbered live Google Places pins, an optional suggested stop order, and Google street-directions links.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City, neighbourhood, landmark, or address; omit only to use Daniel's saved live location" },
        query: { type: "string", description: "What to put on the map; defaults to interesting places and attractions" },
        preferences: { type: "string", description: "Daniel's exact taste or refinement, e.g. 'niche, local, non-touristy ceramics and architecture'" },
        include_bookings: { type: "boolean", description: "Use matching Gmail booking as the map base. Defaults true for route requests, otherwise false for speed." },
        route: { type: "boolean", description: "Order the pins into a suggested route and draw a clearly labelled connector" },
        travel_mode: { type: "string", enum: ["walking", "driving", "transit", "bicycling"], description: "Directions mode; default walking" },
      },
    },
  },
  {
    name: "places_near",
    description:
      "Find real places NEAR Daniel (uses his live location): 'nearest Pizza Express', 'coffee near me', 'where's the closest pharmacy'. Also for a SPECIFIC local place and its opening hours: 'when does the Royal Mail down the street close', 'is the Tesco open now'. Shows a dark interactive map of his area with the places pinned, each with rating, open/closed + today's hours, distance, and one-tap walk/drive/transit directions. Speak the single best answer (nearest, or the closing time he asked for).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "what to find, e.g. 'Pizza Express', 'Royal Mail', 'pharmacy'" },
      },
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
    name: "calculate",
    description:
      "Work out a calculation and show it BIG on screen. Use for any maths, unit/currency conversion, percentages, splits, tips, 'what's X% of Y', 'A times B'. Pass a plain arithmetic expression (js-style: + - * / %, parentheses, and sqrt/round/abs/min/max/pow). Include a short label of what it is.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "e.g. '18% of 240' → '0.18*240', or '(1200/3)*2'" },
        label: { type: "string", description: "what this works out, e.g. 'tip on £240'" },
      },
      required: ["expression"],
    },
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
  "and 'npm run build' — they must pass. Commit only working code, message starting 'self-improve:'. Work on the runner's isolated branch; the controller owns verified merge and delivery, so never push directly to main or claim production is live. " +
  `${SHALLOW_PROVENANCE_RULE} Never replace or reparent a persisted shared branch based on a truncated revision walk. ` +
  "If the change truly requires convex/ schema or src/trigger/ edits, keep them minimal and state clearly in your final " +
  "answer which provider deployment remains to be verified; the controller continues delivery without asking Daniel. Never remove existing capabilities.";

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
  const { searchVideos } = await import("./search");
  const vids = await searchVideos(query);
  if (!vids.length) return "No results found.";
  await showList(vids);
  return (
    vids.map((v, i: number) => `${i + 1}. ${v.title} — ${v.channel} (${v.length}) [id:${v.id}]`).join("\n") +
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
  // no catch: if the panel write fails the tool must FAIL — seven callers
  // tell the model "it's on his screen" based on this succeeding
  await convexMutation("ui:setPanel", { type: "markdown", value: md.slice(0, 7000), title });
}

async function webSearch(query: string): Promise<string> {
  const { searchWeb } = await import("./search");
  const j = await searchWeb(query, 9);
  if (!j) return "Search unavailable right now.";
  const dom = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  // Visual result cards: a live page thumbnail (WordPress mShots, free) with a
  // favicon fallback, shown three at a time in framed tiles.
  const items = j.results.slice(0, 9).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    domain: dom(r.link),
    image: `https://s.wordpress.com/mshots/v1/${encodeURIComponent(r.link)}?w=640`,
    favicon: `https://www.google.com/s2/favicons?domain=${dom(r.link)}&sz=128`,
  }));
  await showWidget({ kind: "webresults", query, answer: j.answer ?? "", items }, `search · ${query.slice(0, 36)}`);
  const parts = [j.answer ? `Answer: ${j.answer}` : "", ...j.results.slice(0, 6).map((r) => `${r.title} — ${r.snippet} (${r.link})`)].filter(Boolean);
  return (parts.join("\n") || "No results.") + "\n(Result cards with page thumbnails are on Daniel's screen, three at a time — speak just the best takeaway.)";
}

// Google Flights rejects metro codes — map them to the main airport.
const METRO: Record<string, string> = {
  LON: "LHR", NYC: "JFK", PAR: "CDG", TYO: "NRT", MIL: "MXP", ROM: "FCO",
  STO: "ARN", MOW: "SVO", BER: "BER", CHI: "ORD", WAS: "IAD", SAO: "GRU", BUE: "EZE",
};

// FREE flights via Travelpayouts/Aviasales (cached real fares + bookable link,
// no cost). Used when the token is in the vault (service "travelpayouts",
// TRAVELPAYOUTS_TOKEN); falls through to SerpAPI otherwise.
async function travelpayoutsFlights(from: string, to: string, departDate: string, returnDate?: string): Promise<string | null> {
  const creds = await getServiceSecrets("travelpayouts").catch(() => ({}) as Record<string, string>);
  const token = creds.TRAVELPAYOUTS_TOKEN ?? process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) return null;
  try {
    const qs = new URLSearchParams({ origin: from, destination: to, departure_at: departDate.slice(0, 7), currency: "gbp", sorting: "price", limit: "10", token });
    if (!returnDate) qs.set("one_way", "true");
    const j: any = await (await fetch(`https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${qs}`, { signal: AbortSignal.timeout(9000) })).json();
    const rows: any[] = (j?.data ?? []).slice(0, 8);
    if (!rows.length) return null;
    const md: string[] = [`## Flights ${from} → ${to} · ${departDate}`, "", "_Cached fares from Aviasales — tap to see live availability._", ""];
    const lines: string[] = [];
    rows.forEach((f, i) => {
      const price = `£${Math.round(f.price)}`;
      const stops = f.transfers === 0 ? "direct" : `${f.transfers} stop${f.transfers > 1 ? "s" : ""}`;
      const dep = String(f.departure_at ?? "").slice(0, 16).replace("T", " ");
      lines.push(`${f.airline} ${f.flight_number ?? ""}: ${price}, ${stops}`);
      md.push(`${i + 1}. **${f.airline} ${f.flight_number ?? ""}** — ${price} · ${stops} · departs ${dep}${f.link ? ` · [book](https://www.aviasales.com${f.link})` : ""}`);
    });
    await showResultsPanel(`flights · ${from}→${to}`, md.join("\n"));
    return lines.slice(0, 5).join("\n") + "\n(Flight options on Daniel's screen — speak just the best one or two. These are cached fares, live availability on tap.)";
  } catch {
    return null;
  }
}

async function flightSearch(args: any): Promise<string> {
  const fix = (c: string) => METRO[c] ?? c;
  const tpFrom = fix(String(args.from ?? "").toUpperCase().trim());
  const tpTo = fix(String(args.to ?? "").toUpperCase().trim());
  const tp = await travelpayoutsFlights(tpFrom, tpTo, String(args.depart_date ?? ""), args.return_date ? String(args.return_date) : undefined);
  if (tp) return tp;
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
  // Prefer Jina's reader (r.jina.ai) — clean article markdown, handles JS-heavy
  // pages far better than raw HTML stripping (mined from JARVIS-MARK5's
  // website-assistant). Fall back to raw fetch if it's unavailable.
  try {
    const clean = url.replace(/^https?:\/\//, "");
    const jr = await fetch(`https://r.jina.ai/https://${clean}`, {
      headers: { "user-agent": "Mozilla/5.0", "x-return-format": "markdown" },
      signal: AbortSignal.timeout(15000),
    });
    if (jr.ok) {
      const md = (await jr.text()).trim();
      if (md.length > 200) return md.slice(0, 9000);
    }
  } catch {
    /* fall through to raw */
  }
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
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
  const [statsRow, earners, series] = await Promise.all([
    rentalQuery("mv/stats_drawer:get", { account: "all" }),
    rentalQuery("mv/top_earners:getRanking", { account: "all", limit: 5 }),
    rentalQuery("mv/earnings_by_period:get", { account: "all", granularity: "monthly", months: 6 }),
  ]);
  const stats = statsRow?.payload;
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
      { label: "inventory", value: Math.round(stats.inventory_worth?.total_gbp ?? 0), prefix: "£" },
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
    `This month £${widget.kpis[0].value}, ${widget.kpis[1].value} active and ${widget.kpis[2].value} upcoming. Inventory is worth about £${widget.kpis[3].value}.` +
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

// Portrait + one-line blurb for a named entity — Wikipedia REST summary
// (keyless, redirects resolve, CORS-open, works for people/places/films/things).
async function wikiPortrait(name: string): Promise<{ img: string; blurb: string; url: string }> {
  const title = encodeURIComponent(name.trim().replace(/\s+/g, "_"));
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`, {
      headers: { accept: "application/json", "user-agent": "jarvis/1.0 (daniel personal ai)" },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const img = j?.thumbnail?.source ?? j?.originalimage?.source ?? "";
      return { img: String(img), blurb: String(j?.extract ?? "").trim(), url: String(j?.content_urls?.desktop?.page ?? "") };
    }
  } catch {
    /* fall through to empty portrait — the tile renders an initial instead */
  }
  return { img: "", blurb: "", url: "" };
}

// A ranked list of named things → portrait-tile overlay. Items arrive already
// in rank order; each portrait is fetched in parallel.
async function showRanking(args: any): Promise<string> {
  const title = String(args.title ?? "Ranking").slice(0, 80).trim() || "Ranking";
  const raw = (Array.isArray(args.items) ? args.items : [])
    .map((it: any) => (typeof it === "string" ? { name: it } : it))
    .filter((it: any) => it && String(it?.name ?? "").trim())
    .slice(0, 8);
  if (raw.length < 2) return "TOOL DID NOTHING: give me at least two ranked items, each with a name.";
  const portraits = await Promise.all(raw.map((it: any) => wikiPortrait(String(it.name))));
  const items = raw.map((it: any, i: number) => ({
    rank: i + 1,
    name: String(it.name).slice(0, 60),
    note: it.note
      ? String(it.note).slice(0, 48)
      : portraits[i].blurb
        ? portraits[i].blurb.split(/[.;]/)[0].slice(0, 48)
        : "",
    // a short bio always sits under the tile; the fuller one shows when focused
    bio: portraits[i].blurb ? portraits[i].blurb.slice(0, 320) : "",
    img: portraits[i].img,
    url: portraits[i].url,
  }));
  await showWidget({ kind: "ranking", title, items }, title.toLowerCase());
  const withImg = items.filter((x: { img: string }) => x.img).length;
  return `On screen: ${items.length} portrait tiles for "${title}", ranked (${withImg} with photos). Speak ONE topper line only — who/what tops it and the single reason — never read the whole list. If he asks about a specific one, call rank_focus to highlight it.`;
}

// Focus/extend a ranking overlay that's already up: pulse tile N and expand its
// bio, without rebuilding the whole thing. Relevance-aware follow-ups land here.
async function rankFocus(args: any): Promise<string> {
  const idx = Math.round(Number(args.index));
  if (!idx || idx < 1) return "TOOL DID NOTHING: which number should I highlight?";
  const panel: any = await convexQuery("ui:getPanel", {}).catch(() => null);
  if (!panel || panel.type !== "widget") return "TOOL DID NOTHING: there's no ranking overlay on screen to focus.";
  let w: any;
  try { w = JSON.parse(panel.value); } catch { return "TOOL DID NOTHING: couldn't read the overlay."; }
  if (w?.kind !== "ranking" || !Array.isArray(w.items)) return "TOOL DID NOTHING: the overlay on screen isn't a ranking.";
  const item = w.items.find((it: any) => it.rank === idx);
  if (!item) return `TOOL DID NOTHING: there's no number ${idx} on screen (it has ${w.items.length}).`;
  w.highlight = idx;
  if (args.bio) item.bio = String(args.bio).slice(0, 400);
  await convexMutation("ui:setPanel", { type: "widget", value: JSON.stringify(w), title: panel.title });
  return `Highlighted #${idx} (${item.name}) — it's pulsing with its bio expanded. Speak about ${item.name} now, a line or two.`;
}

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
  const raw = Number(args.minutes);
  if (!raw || raw <= 0) return "How long, sir?";
  const minutes = Math.min(raw, 24 * 60);
  const label = String(args.label ?? "timer").slice(0, 60);
  const until = Date.now() + Math.round(minutes * 60_000);
  await showWidget({ kind: "timer", label, until, total: Math.round(minutes * 60_000) }, `⏱ ${label}`);
  return `Timer set — ${minutes} minute${minutes === 1 ? "" : "s"} for ${label}. It'll chime on screen when done.`;
}

// Two crypto sparklines (BTC/ETH last ~40h) — fetched in parallel with
// everything else so they never add serial latency to the briefing.
async function cryptoSparks(): Promise<Record<string, number[]>> {
  const pairs: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
  const out: Record<string, number[]> = {};
  await Promise.all(
    Object.entries(pairs).map(async ([label, pair]) => {
      try {
        const k: any = await (
          await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1h&limit=40`, { signal: AbortSignal.timeout(3500) })
        ).json();
        if (Array.isArray(k)) out[label] = k.map((c: any) => Number(c[4]));
      } catch {
        /* tile renders without spark */
      }
    }),
  );
  return out;
}

async function briefingWidget(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const currentLocation = await convexQuery("currentState:getActive", {
    key: "profile.current_location",
  }).catch(() => null) as { value?: string } | null;
  const weatherLocation = currentLocation?.value?.trim() || "London";
  const [w, strip, todos, events, iCloudEvents, wealth, markets, sparks] = await Promise.all([
    fetchWeatherData(weatherLocation).catch(() => null),
    rentalQuery("calendar:getCalendarStrip", { accountSlug: null, startDate: today, days: 1 }),
    q_hub("todos:list"),
    q_hub("events:list"),
    listICloudEvents(Date.now() - 60_000, Date.now() + 14 * 86_400_000).catch(() => []),
    q_hub("wealth:getWealth"),
    fetchMarketData(["bitcoin", "ethereum"], ["GC=F"]).catch(() => []),
    cryptoSparks(),
  ]);
  const short = (x: string) => String(x || "").split(/[|,]/)[0].split(/\s+/).slice(0, 4).join(" ");
  const day0 = Array.isArray(strip) ? strip[0] : null;
  // rentals as a TIMELINE: markers with times + cards
  const rentalMarks: { time: string; kind: string; name: string }[] = [];
  for (const pck of day0?.pickups ?? []) rentalMarks.push({ time: pck.pickupTime || "12:00", kind: "pickup", name: short(pck.items?.[0]?.name ?? pck.imageAlt ?? "item") });
  for (const r of day0?.returns ?? []) rentalMarks.push({ time: r.returnTime || "18:00", kind: "return", name: short(r.items?.[0]?.name ?? r.imageAlt ?? "item") });
  const open = (Array.isArray(todos) ? todos : []).filter((t: any) => !t.done);
  // Keep the briefing instant and deterministic. The foreground Codex worker
  // supplies any judgement in its spoken summary; this data helper never calls
  // a second model or spends a separate inference credit.
  const picked: { text: string; why: string }[] = open
    .slice()
    .sort((left: any, right: any) =>
      Number(right.priority ?? 0) - Number(left.priority ?? 0) ||
      Number(left.dueAt ?? Number.MAX_SAFE_INTEGER) - Number(right.dueAt ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 6)
    .map((todo: any) => ({
      text: String(todo.text).slice(0, 90),
      why: todo.dueAt ? "due soon" : todo.priority ? "high priority" : "open next action",
    }));
  const now = Date.now();
  const upcoming = [...(Array.isArray(events) ? events : []), ...iCloudEvents]
    .filter((e: any) => (e.start ?? 0) >= now)
    .sort((a: any, b: any) => a.start - b.start)
    .slice(0, 4);
  const widget = {
    kind: "briefing2",
    date: new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
    weather: w ? { location: weatherLocation, icon: w.icon, temp: w.temp, desc: w.desc, hours: (w.hours ?? []).slice(0, 8) } : null,
    wealth: wealth?.currentTotalGBP ? Math.round(wealth.currentTotalGBP) : null,
    rentals: rentalMarks.sort((a, b) => a.time.localeCompare(b.time)),
    awayCount: (day0?.away ?? []).length,
    todos: picked,
    calendar: upcoming.map((e: any) => ({
      title: String(e.title).slice(0, 60),
      when: new Date(e.start).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + (e.allDay ? "" : " " + londonTimeStr(e.start)),
    })),
    markets: (markets ?? []).map((r: any) => ({ label: r.label, price: r.price, change: r.change, unit: r.unit, spark: sparks[r.label] })),
  };
  await showWidget(widget, `briefing · ${today}`);
  return (
    `Briefing 2.0 on screen (rentals timeline, tickable day-picks, calendar, markets). ` +
    `Spoken summary material: ${w ? weatherLocation + " " + w.temp + "° " + w.desc : ""}; ${rentalMarks.length} rental movements; top pick: ${picked[0]?.text ?? "none"}. Speak two short sentences max.`
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
  if (args.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(args.time))) return "I need the start time as HH:MM (24-hour).";
  if (args.end_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(args.end_time))) return "I need the end time as HH:MM (24-hour).";
  const allDay = !args.time;
  const start = londonMs(date, args.time ? String(args.time) : "09:00");
  let end = args.end_time ? londonMs(date, String(args.end_time)) : undefined;
  if (end && end <= start) end += 86_400_000;
  const reminderMinutesBefore = Number(args.reminder_minutes_before);
  if (args.reminder_minutes_before != null && (!Number.isFinite(reminderMinutesBefore) || reminderMinutesBefore <= 0))
    return "The calendar alert needs to be a positive number of minutes before the event.";
  await createICloudEvent({
    title: title.slice(0, 140),
    start,
    end,
    allDay,
    location: args.location ? String(args.location).slice(0, 140) : undefined,
    notes: args.notes ? String(args.notes).slice(0, 500) : undefined,
    reminderMinutesBefore: reminderMinutesBefore || undefined,
  });
  return `In iCloud Calendar: "${title}" on ${date}${args.time ? ` at ${args.time}` : " (all day)"}${reminderMinutesBefore ? `, with an alert ${Math.round(reminderMinutesBefore)} minutes before` : ""}. It is live in the overlay and briefings. Confirm casually in one line.`;
}

async function calendarRemove(args: any): Promise<string> {
  const m = String(args.match ?? "").toLowerCase().trim();
  if (!m) return "Which calendar event should I remove?";
  const [iCloudEvents, legacyEvents] = await Promise.all([
    findICloudEvents(m, Date.now() - 86_400_000, Date.now() + 366 * 86_400_000),
    q_hub("events:list"),
  ]);
  const hits = [
    ...iCloudEvents.map((event) => ({ ...event, storage: "icloud" as const })),
    ...(Array.isArray(legacyEvents) ? legacyEvents : [])
      .filter((event: any) => String(event.title).toLowerCase().includes(m))
      .map((event: any) => ({ ...event, storage: "hub" as const })),
  ];
  if (hits.length === 0) return `No event matches "${args.match}".`;
  if (hits.length > 1)
    return `Several events match: ${hits.slice(0, 5).map((e: any) => `"${e.title}" (${londonDateStr(e.start)})`).join(", ")} — ask which.`;
  if (hits[0].storage === "icloud") await deleteICloudEvent(hits[0].eventUrl);
  else await m_hub("events:remove", { id: hits[0]._id });
  return `Deleted "${hits[0].title}" from ${hits[0].storage === "icloud" ? "iCloud Calendar" : "the legacy hub calendar"}.`;
}

// The frosted-glass calendar widget: live iCloud events + legacy hub events +
// rental pickups/returns in one day / week / month view.
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
  const [events, iCloudEvents, strip] = await Promise.all([
    q_hub("events:list"),
    listICloudEvents(startMs, startMs + count * DAY).catch(() => []),
    rentalQuery("calendar:getCalendarStrip", { accountSlug: null, startDate: stripStart, days: Math.min(count, 30) }),
  ]);
  const byDate: Record<string, any[]> = {};
  for (const e of [...(Array.isArray(events) ? events : []), ...iCloudEvents]) {
    const d = londonDateStr(e.start);
    (byDate[d] ??= []).push({
      title: String(e.title).slice(0, 60),
      time: e.allDay ? "" : londonTimeStr(e.start),
      kind: "event",
      location: e.location ? String(e.location).slice(0, 40) : undefined,
      source: e.source === "icloud" ? "iCloud" : "hub",
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

function bookingDisplayWhen(booking: ConfirmedBooking): string {
  if (!booking.start) return "date not found";
  try {
    return new Date(booking.start).toLocaleString("en-GB", {
      timeZone: booking.timeZone ?? "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: booking.allDay ? undefined : "2-digit",
      minute: booking.allDay ? undefined : "2-digit",
    });
  } catch {
    return new Date(booking.start).toISOString();
  }
}

function bookingBoardItem(booking: ConfirmedBooking) {
  const where = booking.location ? ` · ${booking.location}` : "";
  return {
    type: booking.kind,
    title: booking.title,
    provider: booking.provider,
    when: `${bookingDisplayWhen(booking)}${where}`,
    reference: booking.confirmationCode,
    calendar: Boolean(booking.start),
    location: booking.location,
    sourceUrl: booking.sourceUrl,
  };
}

async function bookingsLookup(args: any): Promise<string> {
  const days = Math.max(7, Math.min(730, Math.round(Number(args.days) || 365)));
  const maxResults = Math.max(1, Math.min(40, Math.round(Number(args.max_results) || 20)));
  const query = String(args.query ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const bookings = await lookupGmailBookingsReadOnly({ days, maxResults, search: query || undefined });
  await showWidget({
    kind: "bookings",
    label: `Confirmed bookings · read-only${query ? ` · ${query}` : ""}`,
    calendarAdded: 0,
    readOnly: true,
    items: bookings.map((booking) => ({ ...bookingBoardItem(booking), calendar: false })),
  }, query ? `bookings · ${query.slice(0, 24)}` : "confirmed bookings");
  const located = bookings.filter((booking) => booking.location).length;
  return `Read-only Gmail lookup found ${bookings.length} confirmed booking${bookings.length === 1 ? "" : "s"}${located ? `, including ${located} with a usable address` : ""}. Calendar and trip data were left untouched. Keep the booking board visible and summarise only what Daniel asked for.`;
}

async function bookingsCheck(args: any): Promise<string> {
  const days = Math.max(7, Math.min(730, Math.round(Number(args.days) || 365)));
  const bookings = await scanGmailBookingConfirmations({ days });
  const syncCalendar = args.sync_calendar !== false;
  let created = 0;
  let calendarProblem = "";
  if (syncCalendar) {
    for (const booking of bookings.filter((item) => item.start)) {
      if (calendarProblem) break;
      try {
        const start = Number(booking.start);
        const nearby = await listICloudEvents(start - 2 * 86_400_000, (booking.end ?? start + 86_400_000) + 2 * 86_400_000);
        if (nearby.some((event) => String(event.notes ?? "").includes(booking.marker))) continue;
        await createICloudEvent({
          title: booking.title,
          start,
          end: booking.end,
          allDay: booking.allDay,
          location: booking.location,
          notes: `Confirmed Gmail booking${booking.confirmationCode ? ` · ref ${booking.confirmationCode}` : ""}\n${booking.marker}`,
        });
        created += 1;
      } catch (error: any) {
        calendarProblem = String(error?.message ?? error).slice(0, 150);
      }
    }
  }
  let tripNote = "";
  const tripId = String(args.trip_id ?? "").trim();
  if (tripId) {
    const { getTrip, mergeConfirmedBookings, saveTrip } = await import("./travel");
    const trip = await getTrip(tripId);
    if (!trip) return `I found ${bookings.length} confirmed booking${bookings.length === 1 ? "" : "s"}, but trip ${tripId} was not found.`;
    const start = Date.parse(`${trip.doc.departDate}T00:00:00Z`) - 86_400_000;
    const end = Date.parse(`${trip.doc.returnDate}T23:59:59Z`) + 86_400_000;
    const matching = bookings.filter((booking) => booking.start && booking.start >= start && booking.start <= end);
    const total = mergeConfirmedBookings(trip.doc, matching);
    await saveTrip(trip.id, trip.doc);
    tripNote = ` ${matching.length} matching confirmation${matching.length === 1 ? "" : "s"} merged into ${trip.doc.title}'s itinerary (${total} saved).`;
  }
  await showWidget({
    kind: "bookings",
    label: `Confirmed bookings · last ${days} days`,
    calendarAdded: created,
    items: bookings.map(bookingBoardItem),
  }, "confirmed bookings");
  return `Found ${bookings.length} confirmed booking${bookings.length === 1 ? "" : "s"} in Gmail.${syncCalendar ? ` ${created} new calendar entr${created === 1 ? "y" : "ies"} created; duplicates were skipped.` : " Calendar left untouched."}${tripNote}${calendarProblem ? ` Calendar sync needs attention: ${calendarProblem}.` : ""} Speak one short summary and leave the full booking board on screen.`;
}

async function publishHostAction(action: JarvisHostAction): Promise<void> {
  const payload = {
    ...action,
    id: action.id ?? globalThis.crypto.randomUUID(),
  };
  await convexMutation("ui:setHostAction", {
    value: JSON.stringify(payload),
    title: `${payload.action}${payload.target ? ` · ${payload.target}` : ""}`.slice(0, 160),
  });
}

async function openApp(args: any): Promise<string> {
  if (!String(args.app ?? "").trim()) return "Which app, sir?";
  const app = findHostApp(String(args.app ?? ""));
  if (!app)
    return `I don't have a live URL for "${args.app}".`;
  const expectedUrl = String(args.expected_url ?? "").trim().slice(0, 1_200);
  const hostId = String(args.host_id ?? "").trim().slice(0, 160);
  const embedded = /^https?:\/\//i.test(expectedUrl) && Boolean(hostId);
  await Promise.all([
    convexMutation("ui:setPanel", { type: "launch", value: JSON.stringify({ name: app.name, url: app.url }), title: `launch · ${app.name}` }),
    embedded
      ? publishHostAction({ action: "open_app", target: app.name, url: app.url, expectedUrl, hostId })
      : Promise.resolve(),
  ]);
  await convexMutation("chatQueue:postCard", { threadId: await activeThread(), type: "url", value: app.url, title: `open ${app.name} ↗` }).catch(() => {});
  return embedded
    ? `${app.name} launch sent to this host page; the main Jarvis view also has the fallback card.`
    : `${app.name} is ready on the launch card.`;
}

async function hostUi(args: Record<string, unknown>): Promise<string> {
  const allowed: JarvisHostActionName[] = ["show_widget", "focus", "activate", "navigate", "edit"];
  const action = allowed.includes(String(args.action) as JarvisHostActionName)
    ? String(args.action) as JarvisHostActionName
    : null;
  if (!action) return "TOOL DID NOTHING: choose a valid host action.";
  const expectedUrl = String(args.expected_url ?? "").trim().slice(0, 1_200);
  if (!/^https?:\/\//i.test(expectedUrl)) return "TOOL DID NOTHING: copy the current URL from host context.";
  const hostId = String(args.host_id ?? "").trim().slice(0, 160);
  if (!hostId) return "TOOL DID NOTHING: copy hostId from host context.";
  const target = String(args.target ?? "").trim().slice(0, 500);
  const instruction = String(args.instruction ?? "").trim().slice(0, 1_200);
  if (action !== "edit" && !target) return "TOOL DID NOTHING: name the page element, widget or route.";
  await publishHostAction({ action, target: target || undefined, instruction: instruction || undefined, expectedUrl, hostId });
  if (action === "edit") return "Visual edit selection is open on the host page. Daniel must confirm the highlighted element before engineering work starts.";
  return `Host page action sent: ${action} ${target}.`;
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
  const { searchWeb } = await import("./search");
  const results = await Promise.all(queries.map((q) => searchWeb(q, 6)));
  const md: string[] = [`## Research · ${question}`, ""];
  const forModel: string[] = [];
  let firstLink = "";
  results.forEach((j, i) => {
    if (!j) return;
    md.push(`### Angle ${i + 1}: ${queries[i]}`);
    if (j.answer) {
      md.push(`**Answer box:** ${j.answer}`, "");
      forModel.push(`[angle ${i + 1} answer box] ${j.answer}`);
    }
    for (const r of j.results.slice(0, 4)) {
      if (!firstLink && r.link) firstLink = r.link;
      md.push(`- [${r.title}](${r.link}) — ${r.snippet}`);
      forModel.push(`[${new URL(r.link || "https://x.x").hostname}] ${r.title}: ${r.snippet}`);
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

async function deliberateTool(args: any): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) return "What's the decision?";
  return (
    `DELIBERATE WITH YOUR CURRENT CODEX SUBSCRIPTION MODEL — do not call another model. ` +
    `Give one clear recommendation, the 2-4 decisive reasons, and what would change your mind. ` +
    `Be concrete and opinionated; no fence-sitting.\n\nPROBLEM: ${question}\n\nCONTEXT:\n${String(args.context ?? "").slice(0, 3000)}`
  );
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
  const filing = await creationFiling(args);
  await convexMutation("creations:create", { kind: "image", title, url: finalUrl, thumb: finalUrl, data: prompt, ...filing }).catch(() => {});
  await convexMutation("ui:setPanel", { type: "image", value: finalUrl, title });
  await convexMutation("chatQueue:postCard", { threadId: filing.threadId, type: "image", value: finalUrl, title }).catch(() => {});
  return `Image generated and on screen (saved to the creations library). URL: ${finalUrl}`;
}

async function storeImage(args: any): Promise<string> {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//.test(url)) return "Give me a valid image URL.";
  const title = String(args.title ?? "stored image").slice(0, 80);
  try {
    const { url: stored } = await r2StoreFromUrl(title, url);
    const filing = await creationFiling(args);
    await convexMutation("creations:create", { kind: "image", title, url: stored, thumb: stored, ...filing }).catch(() => {});
    await convexMutation("chatQueue:postCard", { threadId: filing.threadId, type: "image", value: stored, title }).catch(() => {});
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
    const filing = await creationFiling(args);
    await convexMutation("creations:create", { kind: "pdf", title, url, data: md.slice(0, 20_000), ...filing }).catch(() => {});
    await convexMutation("ui:setPanel", { type: "pdf", value: url, title });
    await convexMutation("chatQueue:postCard", { threadId: filing.threadId, type: "pdf", value: url, title: `${title}.pdf` }).catch(() => {});
    return `PDF ready and on screen — download link: ${url} (also saved in the creations library).`;
  } catch (e: any) {
    return `PDF creation failed: ${e?.message ?? e}`;
  }
}

// The infinite canvas: high-level items → excalidraw ops the open board
// applies live (see src/lib/board.ts + BoardView).
async function boardTool(args: any): Promise<string> {
  const { createBoard, loadBoard, saveBoardDoc, itemToOps, capturesToOps } = await import("./board");
  const action = String(args.action ?? "");
  if (action === "create") {
    const title = String(args.title ?? "Board").slice(0, 80);
    const template = ["film", "scavenger", "blank"].includes(String(args.template)) ? String(args.template) : "blank";
    const filing = await creationFiling(args, "boards");
    const { doc } = await createBoard(title, template, {
      project: filing.project,
      inquiry: filing.inquiry,
      threadId: filing.threadId,
    });
    return (
      `Board "${title}" is live on screen (zones: ${Object.keys(doc.zones).join(", ")}). ` +
      `For creative speech use board/capture to extract every relevant category from the same source sentence; use board/add for freeform marks — then ASK Daniel the next good question. ` +
      `For pictures: create_image first, then add {kind:"image", image_url, zone}.`
    );
  }
  const b = await loadBoard(args.title ? String(args.title) : undefined);
  if (!b) return action === "show" ? "No board found — create one first." : "No board to add to — board/create first.";
  if (action === "show") {
    await saveBoardDoc(b.id, b.doc, true);
    const concepts = Object.keys(b.doc.semanticNodes ?? {}).length;
    return `Board "${b.doc.title}" is back on screen. ${concepts ? `${concepts} structured concepts. ` : ""}Zones: ${Object.keys(b.doc.zones).join(", ")}.`;
  }
  if (action === "capture") {
    const captures = Array.isArray(args.captures) ? args.captures : [];
    if (!captures.length) return "Extract the spoken idea into captures first — include every relevant category, not only one.";
    const sourceText = String(args.source_text ?? "").trim();
    const result = capturesToOps(b.doc, captures, sourceText);
    if (!result.added && !result.updated) return "I couldn't find any titled concepts in that capture.";
    const focusBatch = `semantic-${Date.now()}`;
    b.doc.pendingOps.push(...result.ops.map((op: any) => ({ ...op, focusBatch })));
    await saveBoardDoc(b.id, b.doc, true);
    const categories = [...new Set(captures.map((capture: any) => String(capture.category ?? "note")))].join(", ");
    return (
      `Structured ${result.added} new and ${result.updated} updated concept(s) across ${categories}. ` +
      `They are linked and appearing live on "${b.doc.title}". Keep extracting the conversation into every relevant category.`
    );
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
  return "board actions: create, capture, add, update, remove, show.";
}

// Live mind map: create/update re-render on Daniel's screen as you talk.
async function mindMap(args: any, invocationContext?: ToolInvocationContext): Promise<string> {
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
    const id = await convexMutation("creations:create", {
      kind: "canvas",
      title,
      data: JSON.stringify(doc),
      ...(invocationContext?.userMessageId ? { sourceMessageId: invocationContext.userMessageId } : {}),
      ...(await creationFiling(args, "mind maps")),
    });
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
    await convexMutation("creations:update", {
      id: existing._id,
      title: doc.title,
      data: JSON.stringify(doc),
      ...(invocationContext?.userMessageId ? { sourceMessageId: invocationContext.userMessageId } : {}),
    });
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

async function visualSceneTool(args: any, invocationContext?: ToolInvocationContext): Promise<string> {
  const action = ["create", "update", "show", "focus"].includes(String(args.action)) ? String(args.action) : "create";
  let existing: any = null;
  let sceneId = args.scene_id ? String(args.scene_id) : "";

  if (action !== "create") {
    if (!sceneId) {
      const panel: any = await convexQuery("ui:getPanel", {}).catch(() => null);
      if (panel?.type === "scene") {
        try { sceneId = String(JSON.parse(panel.value)?.creationId ?? ""); } catch { /* use latest */ }
      }
    }
    existing = sceneId
      ? await convexQuery("creations:get", { id: sceneId }).catch(() => null)
      : await convexQuery("creations:latest", { kind: "scene", titleMatch: args.title ? String(args.title) : undefined }).catch(() => null);
    if (!existing?.data) return "TOOL DID NOTHING: no matching visual workspace exists yet — use action=create.";
    sceneId = String(existing._id);
  }

  if (action === "show") {
    await convexMutation("ui:setPanel", { type: "scene", value: JSON.stringify({ creationId: sceneId }), title: `visual · ${existing.title}` });
    return `Visual workspace "${existing.title}" is back on screen (scene_id ${sceneId}).`;
  }

  const current: VisualScene | null = existing?.data ? parseVisualSceneJson(existing.data, existing.title) : null;
  const input = {
    ...args,
    focusBlockId: Object.prototype.hasOwnProperty.call(args, "focus_block_id") ? args.focus_block_id : undefined,
    blocks: action === "focus" ? [] : args.blocks,
  } as Record<string, unknown>;
  let scene = mergeVisualScene(current, input);
  if (!scene.blocks.length && !scene.capability)
    return "TOOL DID NOTHING: add at least one visual block or choose a capability.";

  if (action === "create") {
    const filing = await creationFiling(args, "visual workspaces");
    sceneId = String(await convexMutation("creations:create", {
      kind: "scene",
      title: scene.title,
      data: JSON.stringify(scene),
      ...filing,
      ...(invocationContext?.userMessageId ? { sourceMessageId: invocationContext.userMessageId } : {}),
    }));
    await convexMutation("chatQueue:postCard", {
      threadId: filing.threadId,
      type: "scene",
      value: JSON.stringify({ creationId: sceneId }),
      title: scene.title,
    }).catch(() => {});
  } else {
    let write: any = await convexMutation("creations:updateScene", {
      id: sceneId,
      expectedUpdatedAt: existing.updatedAt,
      title: scene.title,
      data: JSON.stringify(scene),
      ...(invocationContext?.userMessageId ? { sourceMessageId: invocationContext.userMessageId } : {}),
    });
    if (!write?.ok && write?.reason === "conflict" && write.data) {
      // Another agent landed first. Rebase the same stable-id patch once; do
      // not make Daniel arbitrate harmless concurrent visual composition.
      scene = mergeVisualScene(parseVisualSceneJson(write.data, write.title), input);
      write = await convexMutation("creations:updateScene", {
        id: sceneId,
        expectedUpdatedAt: write.updatedAt,
        title: scene.title,
        data: JSON.stringify(scene),
        ...(invocationContext?.userMessageId ? { sourceMessageId: invocationContext.userMessageId } : {}),
      });
    }
    if (!write?.ok) return "TOOL DID NOTHING: the visual workspace changed concurrently; show it and retry the patch.";
  }
  await convexMutation("ui:setPanel", {
    type: "scene",
    value: JSON.stringify({ creationId: sceneId }),
    title: `visual · ${scene.title}`,
  });
  const verb = action === "focus" ? "focused" : action === "update" ? "updated" : "created";
  return `Visual workspace "${scene.title}" ${verb} live (scene_id ${sceneId}; blocks: ${scene.blocks.map((block) => block.id).join(", ") || "bound capability"}). Keep this id and patch stable blocks as the conversation evolves.`;
}

async function projectGoalTool(args: any): Promise<string> {
  const action = ["review", "upsert", "advance", "block", "achieve"].includes(String(args.action)) ? String(args.action) : "review";
  const project = String(args.project ?? "").trim().toLowerCase();
  const goals: any[] = (await convexQuery("projectIntelligence:listGoals", {
    project: project || undefined,
    limit: 60,
  }).catch(() => [])) ?? [];

  if (action === "review") {
    const existing: any = await convexQuery("creations:latest", { kind: "scene", titleMatch: "project portfolio" }).catch(() => null);
    if (existing?._id) {
      await convexMutation("ui:setPanel", { type: "scene", value: JSON.stringify({ creationId: String(existing._id) }), title: "visual · Project portfolio" });
    } else {
      await visualSceneTool({ action: "create", title: "Project portfolio", subtitle: "Purpose, live provider state and durable outcomes", capability: "project_portfolio" });
    }
    const active = goals.filter((goal) => goal.status === "active").length;
    const blocked = goals.filter((goal) => goal.status === "blocked").length;
    return `Live project portfolio is on screen. ${active} durable goal${active === 1 ? "" : "s"} active${blocked ? `, ${blocked} blocked` : ""}; provider health and purpose are separate signals.`;
  }

  const title = String(args.title ?? "").trim();
  if (!project || !title) return "TOOL DID NOTHING: project and goal title are required.";
  const existing = goals.find((goal) => goal.title.toLowerCase() === title.toLowerCase()) ??
    goals.find((goal) => goal.title.toLowerCase().includes(title.toLowerCase()) || title.toLowerCase().includes(goal.title.toLowerCase()));
  const outcome = String(args.outcome ?? existing?.outcome ?? "").trim();
  if (!outcome) return "TOOL DID NOTHING: a new goal needs an observable outcome, not just a title.";
  const status = action === "block" ? "blocked" : action === "achieve" ? "achieved" : "active";
  const id = await convexMutation("projectIntelligence:upsertGoal", {
    project,
    title: existing?.title ?? title,
    outcome,
    status,
    priority: Number.isFinite(Number(args.priority)) ? Number(args.priority) : existing?.priority,
    progress: action === "achieve" ? 100 : Number.isFinite(Number(args.progress)) ? Number(args.progress) : existing?.progress,
    nextAction: args.next_action !== undefined ? String(args.next_action) : existing?.nextAction,
    blockedBy: action === "block" ? String(args.blocked_by ?? "Unspecified blocker") : args.blocked_by !== undefined ? String(args.blocked_by) : existing?.blockedBy,
    evidence: Array.isArray(args.evidence) ? [...(existing?.evidence ?? []), ...args.evidence.map(String)].slice(-20) : existing?.evidence,
    owner: args.owner !== undefined ? String(args.owner) : existing?.owner,
  });
  return `Project outcome ${id} ${existing ? "updated" : "created"}: ${project} · ${existing?.title ?? title} is ${status}${action === "achieve" ? " with evidence recorded" : ""}.`;
}

async function chartTool(args: any, invocationContext?: ToolInvocationContext): Promise<string> {
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
  await convexMutation("creations:create", {
    kind: "chart",
    title,
    data: JSON.stringify(widget),
    ...(await creationFiling(args, "charts")),
    ...(invocationContext?.userMessageId ? { sourceMessageId: invocationContext.userMessageId } : {}),
  });
  return `Chart "${title}" is on screen and saved in the creations library. Speak one takeaway.`;
}

// News as a cinematic feed: hero cards with images fading through, then a grid.
async function newsToday(args: any): Promise<string> {
  const topic = args.topic ? String(args.topic).trim() : "";
  const { searchNews } = await import("./search");
  const raw = await searchNews(topic || null);
  const items = raw
    .filter((n) => n.title)
    .slice(0, 12)
    .map((n) => ({
      image: n.image,
      title: n.title,
      subtitle: `${n.source}${n.date ? " · " + n.date : ""}`,
      url: n.link,
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
// Places near Daniel: Google Places (New) Text Search biased to his live
// location, rendered as a dark map + cards with hours/rating/distance.
function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371, dLat = ((b[0] - a[0]) * Math.PI) / 180, dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180, lat2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}
type TravelPlace = TravelMapPoint & {
  name: string;
  address: string;
  rating?: number;
  reviews?: number;
  openNow?: boolean;
  hoursToday?: string;
  type?: string;
  dist: number | null;
  mapsUri: string;
};

const GOOGLE_TRAVEL_PLACE_FIELDS = "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.currentOpeningHours,places.regularOpeningHours,places.googleMapsUri,places.primaryTypeDisplayName";

async function searchTravelPlaces(
  key: string,
  textQuery: string,
  options: { center?: TravelMapPoint; radiusMetres?: number; maxResults?: number } = {},
): Promise<TravelPlace[]> {
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": GOOGLE_TRAVEL_PLACE_FIELDS,
    },
    body: JSON.stringify(googlePlacesSearchBody(textQuery, options)),
    signal: AbortSignal.timeout(9_000),
  });
  if (!response.ok) throw new Error(`Places lookup failed (${response.status})`);
  const payload = await response.json();
  const dayIndex = (new Date().getDay() + 6) % 7;
  return (Array.isArray(payload.places) ? payload.places : []).map((place: any) => {
    const lat = Number(place.location?.latitude);
    const lng = Number(place.location?.longitude);
    const opening = place.currentOpeningHours ?? place.regularOpeningHours;
    const todayLine = (opening?.weekdayDescriptions ?? [])[dayIndex] ?? "";
    return {
      name: String(place.displayName?.text ?? "").slice(0, 80),
      address: String(place.formattedAddress ?? "").slice(0, 180),
      rating: Number.isFinite(Number(place.rating)) ? Number(place.rating) : undefined,
      reviews: Number.isFinite(Number(place.userRatingCount)) ? Number(place.userRatingCount) : undefined,
      openNow: typeof opening?.openNow === "boolean" ? opening.openNow : undefined,
      hoursToday: String(todayLine).replace(/^[^:]+:\s*/, "").slice(0, 80),
      type: String(place.primaryTypeDisplayName?.text ?? "").slice(0, 60),
      lat,
      lng,
      dist: options.center && Number.isFinite(lat) && Number.isFinite(lng)
        ? Math.round(haversine([options.center.lat, options.center.lng], [lat, lng]) * 10) / 10
        : null,
      mapsUri: String(place.googleMapsUri ?? ""),
    };
  }).filter((place: TravelPlace) => Number.isFinite(place.lat) && Number.isFinite(place.lng) && Boolean(place.name));
}

function chooseTravelBooking(bookings: ConfirmedBooking[], location?: string): ConfirmedBooking | undefined {
  const needle = String(location ?? "").toLocaleLowerCase();
  const now = Date.now();
  return [...bookings]
    .filter((booking) => booking.kind === "stay" && booking.location)
    .sort((left, right) => {
      const leftMatch = needle && `${left.bookingName ?? ""} ${left.location ?? ""}`.toLocaleLowerCase().includes(needle) ? 1 : 0;
      const rightMatch = needle && `${right.bookingName ?? ""} ${right.location ?? ""}`.toLocaleLowerCase().includes(needle) ? 1 : 0;
      if (leftMatch !== rightMatch) return rightMatch - leftMatch;
      const leftFuture = (left.end ?? left.start ?? 0) >= now ? 1 : 0;
      const rightFuture = (right.end ?? right.start ?? 0) >= now ? 1 : 0;
      return rightFuture - leftFuture || (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER);
    })[0];
}

async function travelMap(args: any): Promise<string> {
  const request = normalizeTravelMapRequest(args ?? {});
  const key = await getSecret("google", "GOOGLE_PLACES_API_KEY").catch(() => "");
  if (!key) return "Maps key unavailable.";
  try {
    const bookingsPromise = request.includeBookings
      ? lookupGmailBookingsReadOnly({ days: 730, maxResults: 12, search: request.location }).catch(() => [] as ConfirmedBooking[])
      : Promise.resolve([] as ConfirmedBooking[]);
    let center: TravelMapPoint & { label: string; detail?: string; source: "saved_location" | "google_places" };
    if (request.location) {
      const locationMatch = (await searchTravelPlaces(key, request.location, { maxResults: 1 }))[0];
      if (!locationMatch) return `I couldn't locate ${request.location} on the map.`;
      center = {
        lat: locationMatch.lat,
        lng: locationMatch.lng,
        label: request.location,
        detail: locationMatch.address || locationMatch.name,
        source: "google_places",
      };
    } else {
      const saved: any = await convexQuery("ui:getLocation", {}).catch(() => null);
      const [lat, lng] = String(saved?.value ?? "").split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return "I don't have a usable current location yet — share a city/address or enable location once in options.";
      }
      center = { lat, lng, label: "Saved current location", source: "saved_location" };
    }

    const bookings = await bookingsPromise;
    const booking = chooseTravelBooking(bookings, request.location);
    const [found, bookingGeocode] = await Promise.all([
      searchTravelPlaces(key, googlePlacesTextQuery(request), { center, radiusMetres: 14_000, maxResults: 10 }),
      booking?.location
        ? searchTravelPlaces(key, booking.location, { center, radiusMetres: 30_000, maxResults: 1 }).then((rows) => rows[0]).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    if (!found.length) return `I couldn't find places matching “${googlePlacesTextQuery(request)}”.`;

    const basePoint = bookingGeocode ? { lat: bookingGeocode.lat, lng: bookingGeocode.lng } : center;
    const selected = found
      .map((place) => ({ ...place, dist: Math.round(haversine([basePoint.lat, basePoint.lng], [place.lat, place.lng]) * 10) / 10 }))
      .sort((left, right) => (left.dist ?? 99) - (right.dist ?? 99))
      .slice(0, request.route ? 8 : 10);
    const places = request.route ? orderTravelMapPoints(basePoint, selected) : selected;
    const routeUrl = request.route
      ? googleDirectionsUrl({ origin: basePoint, stops: places, mode: request.travelMode })
      : undefined;
    const route = request.route ? {
      label: `Suggested ${request.travelMode} order · straight map connector`,
      note: "The line shows stop order, not street geometry; open Google directions for the navigable route.",
      mode: request.travelMode,
      coordinates: [basePoint, ...places].map((point) => [point.lng, point.lat]),
      googleMapsUrl: routeUrl,
      order: places.map((place) => place.name),
    } : undefined;
    const base = booking ? {
      label: booking.bookingName ?? booking.provider,
      address: booking.location,
      source: "Read-only Gmail booking",
      lat: bookingGeocode?.lat,
      lng: bookingGeocode?.lng,
    } : undefined;
    const locationLabel = request.location ?? center.label;
    await showWidget({
      kind: "places",
      query: request.query,
      preferences: request.preferences,
      locationLabel,
      center,
      base,
      route,
      items: places,
    }, `map · ${locationLabel.slice(0, 32)}`);
    return `Interactive map opened for ${locationLabel} with ${places.length} real place pin${places.length === 1 ? "" : "s"}${base ? ` and ${base.label} marked as the read-only Gmail booking base` : ""}${routeUrl ? ` in a suggested ${request.travelMode} order with a Google directions link` : ""}. Keep the map visible and answer with a short, preference-aware summary.`;
  } catch (error: any) {
    return `Travel map lookup failed: ${String(error?.message ?? error).slice(0, 120)}.`;
  }
}

async function placesNear(args: any): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "What am I looking for?";
  const loc: any = await convexQuery("ui:getLocation", {}).catch(() => null);
  if (!loc?.value) return "I don't have your location yet, sir — tap the location toggle in the options panel (⚙) once and it stays on.";
  const [lat, lng] = String(loc.value).split(",").map(Number);
  const key = await getSecret("google", "GOOGLE_PLACES_API_KEY").catch(() => "");
  if (!key) return "Maps key unavailable.";
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.currentOpeningHours,places.regularOpeningHours,places.googleMapsUri,places.primaryTypeDisplayName",
      },
      body: JSON.stringify(googlePlacesSearchBody(query, { center: { lat, lng }, radiusMetres: 8_000, maxResults: 10 })),
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return `Places lookup failed (${r.status}).`;
    const j = await r.json();
    const dayIdx = (new Date().getDay() + 6) % 7; // Google weekday arrays start Monday
    const places = (j.places ?? []).map((p: any) => {
      const plat = p.location?.latitude, plng = p.location?.longitude;
      const oh = p.currentOpeningHours ?? p.regularOpeningHours;
      const todayLine = (oh?.weekdayDescriptions ?? [])[dayIdx] ?? "";
      return {
        name: String(p.displayName?.text ?? "").slice(0, 60),
        address: String(p.formattedAddress ?? "").slice(0, 80),
        rating: p.rating,
        reviews: p.userRatingCount,
        openNow: oh?.openNow,
        hoursToday: todayLine.replace(/^[A-Za-z]+:\s*/, ""),
        type: String(p.primaryTypeDisplayName?.text ?? ""),
        lat: plat, lng: plng,
        dist: plat != null ? Math.round(haversine([lat, lng], [plat, plng]) * 10) / 10 : null,
        mapsUri: String(p.googleMapsUri ?? ""),
      };
    }).filter((p: any) => p.lat != null).sort((a: any, b: any) => (a.dist ?? 99) - (b.dist ?? 99));
    if (!places.length) return `Couldn't find "${query}" near you.`;
    await showWidget({ kind: "places", query, center: { lat, lng }, items: places.slice(0, 10) }, `near you · ${query.slice(0, 24)}`);
    const nearest = places[0];
    return (
      `PLACES on a dark map on screen (${places.length} pins near Daniel, tap-through directions). ` +
      `Nearest: ${nearest.name}, ${nearest.dist}km, ${nearest.openNow === false ? "closed now" : nearest.openNow ? "open now" : ""}${nearest.hoursToday ? ` (today ${nearest.hoursToday})` : ""}. ` +
      `Answer his exact question in one line — if he asked closing time, give THAT place's closing time from hoursToday.`
    );
  } catch (e: any) {
    return `Places lookup error: ${String(e?.message ?? e).slice(0, 100)}`;
  }
}

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
// Cheapest live price for a product query (UK) — shared by shop_search and the
// price-watch cron. Returns the best match or null.
export async function cheapestPrice(query: string): Promise<{ priceNum: number; title: string; url: string } | null> {
  const { searchShopping } = await import("./search");
  const rows = (await searchShopping(query)).filter((r) => r.priceNum > 0);
  if (!rows.length) return null;
  rows.sort((a, b) => a.priceNum - b.priceNum);
  const r = rows[0];
  return { priceNum: r.priceNum, title: r.title, url: r.link };
}

async function shopSearch(args: any): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "What am I finding?";
  const { searchShopping } = await import("./search");
  const rows = await searchShopping(query);
  const FAST = /same.day|next.day|tomorrow|\b1 day|\b1-2 day|24 ?h/i;
  let items = rows.map((r) => ({
    image: r.image,
    title: r.title,
    priceNum: r.priceNum,
    price: r.price,
    merchant: r.source,
    delivery: r.delivery ?? "",
    rating: r.rating,
    reviews: r.reviews,
    url: r.link,
  }));
  const cap = Number(args.max_price_gbp) || 0;
  if (cap) items = items.filter((i: any) => i.priceNum <= cap);
  // genuinely fast delivery floats up ("free delivery on £120+" is not fast)
  items.sort((a: any, b: any) => (FAST.test(b.delivery) ? 1 : 0) - (FAST.test(a.delivery) ? 1 : 0));
  items = items.slice(0, 12).map(({ priceNum, ...i }: any) => i);
  if (!items.length) return `Nothing solid for "${query}" — refine the search terms.`;
  await showWidget({ kind: "shop", label: query, items }, `shopping · ${query.slice(0, 30)}`);
  return (
    `SHOP FRAMES on screen, numbered 1-${items.length} (three per page, arrows to page). FULL LIST: ` +
    items.map((i: any, n: number) => `${n + 1}. ${i.title} — ${i.price} at ${i.merchant}`).join(" | ") +
    ` — ask Daniel which fits or what to change. If he says "more like number N": read item N's title above, pull out its defining attributes (brand/style/colour/cut) and run a fresh shop_search built from them — tell him what you noticed about N. If he picks one: offer the checkout agent (dispatch_agent, mcp browserbase, task: open the merchant page, add EXACTLY that item to the cart, fill the order details, proceed to checkout and return the payment-page link - NEVER pay).`
  );
}

// Live writing desk: one creations row per draft title, panel re-renders on
// every revision so Daniel watches the text change as they talk about it.
async function draftDoc(args: any): Promise<string> {
  const title = String(args.title ?? "Draft").slice(0, 80);
  const content = String(args.content ?? "");
  if (!content.trim()) return "TOOL DID NOTHING: no content passed.";
  const existing: any = await convexQuery("creations:latest", { kind: "doc", titleMatch: title.toLowerCase() }).catch(() => null);
  const categoryByType: Record<string, string> = {
    email: "emails",
    note: "notes",
    document: "documents",
    message: "messages",
    script: "scripts",
  };
  const filing = await creationFiling(args, categoryByType[String(args.document_type ?? "")] ?? undefined);
  let id = existing?._id ?? null;
  if (id && filing.project && existing.project && existing.project !== filing.project) id = null;
  if (id && filing.inquiry && existing.inquiry && existing.inquiry !== filing.inquiry) id = null;
  if (id) await convexMutation("creations:update", { id, title, data: content, ...filing });
  else id = await convexMutation("creations:create", { kind: "doc", title, data: content, ...filing });
  await convexMutation("ui:setPanel", { type: "doc", value: JSON.stringify({ creationId: id }), title: `draft · ${title}` });
  const words = content.trim().split(/\s+/).length;
  return `Draft "${title}" is on screen (${words} words) and updates LIVE. Discuss it in one or two short sentences — don't read it out. To revise, call draft again with the same title and the full new text.`;
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
  return (
    `LIVE DAY DATA. Build the plan yourself with your current Codex subscription reasoning; do not call another model. ` +
    `Use at most three meaningful priorities, respect fixed events and rentals, include realistic breaks and an honest skip-today list. ` +
    `Then show the complete plan with show_results and speak only the top priority and first block. Offer calendar_add only after Daniel approves.\n\n${facts}`
  );
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
  // Alerts are helpful decoration, not a reason to withhold the chart. Fetch
  // them beside the market data so the primary visual is never serialized
  // behind an unrelated Convex read.
  const [candles, rules] = await Promise.all([
    fetchCandles(a, interval),
    convexQuery("watchRules:list", { status: "active", limit: 80 }).catch(() => [] as any[]),
  ]);
  if (candles.length < 30) return `No chart data for ${a.label} on ${interval}.`;
  const levels = keyLevels(candles);
  const w = chartWidget(a, interval, candles, levels);
  const symbols = new Set([a.binance, a.yahoo, String(args.asset ?? "").toUpperCase()].filter(Boolean));
  (w as any).alerts = (rules as any[])
    .filter((rule) => rule.kind === "asset" && symbols.has(String(rule.definition?.symbol ?? "").toUpperCase()))
    .map((rule) => ({
      price: Number(rule.definition.threshold),
      operator: String(rule.definition.operator),
      label: rule.label,
    }))
    .filter((alert) => Number.isFinite(alert.price));
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
  const { resolveAsset, fetchCandles, keyLevels, chartWidget, fetchVix, fetchCryptoFlows, fetchNews, sma, rsi } =
    await import("./markets");
  const a = resolveAsset(String(args.asset ?? ""));
  if (!a) return `Couldn't resolve "${args.asset}" to an asset.`;
  const interval = ["4h", "1d", "1w"].includes(String(args.interval)) ? String(args.interval) : "1d";

  const [daily, weekly, vix, flows, news] = await Promise.all([
    fetchCandles(a, interval, 300),
    fetchCandles(a, "1w", 200),
    a.kind === "crypto" ? Promise.resolve(null) : fetchVix(),
    a.kind === "crypto" && a.binance ? fetchCryptoFlows(a.binance) : Promise.resolve(""),
    fetchNews(`${a.label} ${a.kind === "crypto" ? "crypto" : a.kind}`),
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

  const w = chartWidget(a, interval, daily, levels, []);
  await convexMutation("ui:setPanel", { type: "widget", value: JSON.stringify(w), title: `${a.label} · analysis` });
  return (
    `MARKET DOSSIER — the chart is on screen. Analyse this yourself with the current Codex subscription model using Wyckoff structure, trend, volume, momentum, catalysts and invalidation. Give a clear bullish/bearish/neutral verdict, key level, invalidation and what changes the view; this is analysis, never an execution instruction.\n\n` +
    dossier.slice(0, 11_000)
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
  let reuseId: string | undefined = args.trip_id ? String(args.trip_id) : undefined;
  const existing = await latestTrip();
  const normalizeDestination = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!reuseId && existing && normalizeDestination(existing.doc.destination) === normalizeDestination(destination)) reuseId = existing.id;
  const { id, doc } = await scoutTrip({
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
  const providerIssues = Object.entries(doc.providers ?? {})
    .filter(([, state]: any) => state.status === "error")
    .map(([provider, state]: any) => `${provider}: ${state.error ?? "failed"}`);
  return (
    `Trip ${id} is live in the guided workspace. Found: ${doc.flights.length} flights (best ${f ? `${f.airline} £${f.priceGbp}pp, ${f.stops === 0 ? "direct" : f.stops + " stop"}` : args.include_flights === false ? "skipped by choice" : "none"}), ` +
      `${doc.stays.length} stays within budget (e.g. ${cheapStay ? `${cheapStay.name} ★${cheapStay.rating} £${cheapStay.totalGbp} total` : "none"}), ` +
      `${doc.activities.length} activities (top: ${doc.activities.slice(0, 3).map((a) => a.name).join(", ")}). ` +
      (providerIssues.length ? `Provider issues shown with retry state: ${providerIssues.join("; ")}. ` : "") +
      `Budget £${budget}. Speak TWO short sentences with the single best flight + stay combo, then ask what he wants to lock in. ` +
      `Use trip_update with trip_id ${id} to lock choices (hotel names: ${doc.stays.slice(0, 6).map((s) => s.name).join(" | ")}).`
  );
}

async function tripUpdateTool(args: any): Promise<string> {
  const { getTrip, saveTrip, computeTransfer, hubAction } = await import("./travel");
  const tripId = String(args.trip_id ?? "").trim();
  if (!tripId) return "TRIP ID MISSING — use the id on the visible trip workspace; never edit an implicit latest trip.";
  const t = await getTrip(tripId);
  if (!t) return `Trip ${tripId} was not found.`;
  const { doc } = t;
  const action = String(args.action ?? "");
  if (action === "show") {
    await saveTrip(t.id, doc);
    return `Trip "${doc.title}" is back on the globe screen.`;
  }
  if (action === "lock_flight") {
    const selected = Number(args.flight_index);
    if (!Number.isInteger(selected) || selected < 1) return "Choose a specific flight from the list before locking it.";
    const i = selected - 1;
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
      maxPages: 1,
    }).catch(() => ({ options: [] }));
    const stays = (res.options ?? []).slice(0, 24);
    if (!stays.length) return "That search came back empty — loosen the limits.";
    doc.stays = stays;
    await saveTrip(t.id, doc);
    return `Re-scouted: ${stays.length} ${args.vacation_rentals ? "rentals" : "hotels"} now on the globe (top: ${stays.slice(0, 4).map((s: any) => `${s.name} £${s.totalGbp ?? s.priceGbp}`).join(", ")}).`;
  }
  return "Unknown trip action.";
}

async function tripFinalizeTool(args: any): Promise<string> {
  const { getTrip, saveTrip, computeTransfer, buildItinerary, tripToCalendar, tripToMindmap } = await import("./travel");
  const tripId = String(args.trip_id ?? "").trim();
  if (!tripId) return "TRIP ID MISSING — finalize the exact visible trip, never whichever draft happens to be newest.";
  if (typeof args.add_to_calendar !== "boolean") return "CALENDAR CHOICE MISSING — ask Daniel whether to sync the reviewed itinerary to his calendar.";
  const t = await getTrip(tripId);
  if (!t) return `Trip ${tripId} was not found.`;
  const { doc } = t;
  if (doc.includeFlights !== false && doc.flights.length && !doc.locked.flight)
    return "Choose and lock a specific flight first — I won't silently select option one.";
  if (!doc.locked.stay) return "Lock a hotel first (trip_update lock_stay) — the itinerary and transfer hang off it.";
  if (!doc.transfer) doc.transfer = await computeTransfer(doc);
  doc.itinerary = buildItinerary(doc);
  let calNote = "";
  if (args.add_to_calendar === true) {
    try {
      const n = await tripToCalendar(doc, t.id);
      doc.calendarSyncedAt = Date.now();
      calNote = ` ${n} calendar items synchronized idempotently (GMT/BST aware).`;
    } catch (error: any) {
      await saveTrip(t.id, doc);
      throw new Error(`Trip itinerary was saved, but calendar sync failed and was not marked complete: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  doc.status = "planned";
  await saveTrip(t.id, doc);
  const mapId = await tripToMindmap(doc, t.id).catch(() => "");
  return (
    `Trip locked in: ${doc.itinerary?.length} days planned, total ≈ £${doc.totals?.total} of £${doc.budgetGbp}.` +
    calNote +
    (mapId ? ` Interactive trip map saved to the creations library.` : "") +
    ` The full plan is on screen. Speak one short confident summary.`
  );
}

async function creationsList(args: any): Promise<string> {
  const kind = ["board", "scene", "canvas", "chart", "image", "pdf", "doc", "trip"].includes(String(args.kind)) ? String(args.kind) : undefined;
  const folder = args.folder ? String(args.folder).slice(0, 160) : undefined;
  const rows: any[] = (await convexQuery("creations:list", { kind, folder, limit: 30 })) ?? [];
  await convexMutation("ui:setPanel", { type: "creations", value: JSON.stringify({ kind: kind ?? null, folder: folder ?? null }), title: "saved work" });
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

async function resolveMissionProjectAdmissions(
  repositories: readonly (string | null | undefined)[],
): Promise<ProjectSourceAdmission[]> {
  const scopes = new Map<string, string | undefined>();
  for (const repository of repositories.length ? repositories : [undefined]) {
    const raw = repository?.trim();
    const canonical = raw ? canonicalizeRepository(raw, { allowShortName: true }) : null;
    if (raw && !canonical) throw new Error("Repository is not a canonical JARVIS project");
    scopes.set(canonical ?? "evidence", canonical ?? undefined);
  }
  return await Promise.all([...scopes.values()].map((repository) => resolveProjectSourceAdmission(repository)));
}

function admittedProject(
  admissions: readonly ProjectSourceAdmission[],
  repository?: string | null,
): ProjectSourceAdmission {
  const canonical = repository ? canonicalizeRepository(repository, { allowShortName: true }) : null;
  const admission = admissions.find((candidate) => candidate.repository === (canonical ?? undefined));
  if (!admission) throw new Error(`Mission lost project admission for ${canonical ?? "evidence"}`);
  return admission;
}

async function creationFiling(args: any, category?: string): Promise<{
  category?: string;
  project?: string;
  inquiry?: string;
  threadId: string;
}> {
  const project = String(args?.project ?? "").trim().slice(0, 80) || undefined;
  const inquiry = String(args?.inquiry ?? "").trim().slice(0, 80) || undefined;
  return { category, project, inquiry, threadId: await activeThread() };
}

export async function executeTool(
  name: string,
  args: any,
  hostContext: ToolExecutionHostContext = {},
): Promise<string> {
  const authTokenHash = hostContext.authTokenHash;
  const invocationContext = normalizeToolInvocationContext(hostContext.invocationContext, {
    allowUserMessageId: true,
  });
  const boundedHostContext: ToolExecutionHostContext = {
    ...(authTokenHash ? { authTokenHash } : {}),
    ...(invocationContext ? { invocationContext } : {}),
  };
  return await withAdminSession(authTokenHash, async () => {
    switch (name) {
    case "dispatch_agent": {
      const task = exactTextWorkOrder(String(args.task ?? ""));
      if (!task.trim()) return "Give me the outcome you want the team to own.";
      const repo = args.repo ? String(args.repo) : undefined;
      const [{ routeWork, suggestedAcceptanceCriteria }, { TEAM_BY_SLUG }] = await Promise.all([
        import("../mastra/routing"),
        import("../mastra/team"),
      ]);
      const route = routeWork(task, {
        repo,
        requestedModel: args.model ? String(args.model) : undefined,
        readonly: typeof args.readonly === "boolean" ? args.readonly : undefined,
      });
      const requested = String(args.agent_id ?? "");
      const agentId = ["paul", "atlas", "iris", "maya", "sentry"].includes(requested)
        ? (requested as keyof typeof TEAM_BY_SLUG)
        : route.agentId;
      const originThreadId = await activeThread();
      const criteria = Array.isArray(args.acceptance_criteria) && args.acceptance_criteria.length
        ? args.acceptance_criteria.map(String).slice(0, 8)
        : suggestedAcceptanceCriteria(task, route);
      const protocolV2 = v2AdmissionEnabled();
      const [projectAdmission] = protocolV2 ? await resolveMissionProjectAdmissions([repo]) : [undefined];
      const missionId = await convexMutation(admissionMutationName("mission"), {
        authTokenHash,
        goal: task,
        agentCount: 1,
        ...(protocolV2 ? { mode: "single", projectAdmissions: [projectAdmission!] } : {}),
        originThreadId,
        managerAgentId: "jarvis",
        priority: route.priority,
        risk: route.risk,
        acceptanceCriteria: criteria,
      });
      const jobId = await convexMutation(admissionMutationName("job"), {
        authTokenHash,
        task,
        repo: projectAdmission?.repository ?? repo,
        missionId: String(missionId),
        readonly: route.readonly,
        model: route.model,
        mcp: Array.isArray(args.mcp) ? args.mcp.map(String) : undefined,
        originThreadId,
        visibility: "conversation",
        agentId,
        risk: route.risk,
        priority: route.priority,
        approvalRequired: route.approvalRequired,
        acceptanceCriteria: criteria,
        modelReason: route.reason,
        parentJobId: args.parent_job_id ? String(args.parent_job_id) : undefined,
        label: `${TEAM_BY_SLUG[agentId].name} · ${task.slice(0, 58)}`,
      });
      if (!route.approvalRequired) await wakeAgentFleet(`job:${String(jobId)}`).catch(() => false);
      return route.approvalRequired
        ? `${TEAM_BY_SLUG[agentId].name} has a scoped plan ready as job ${jobId}, but it includes a consequential external action. I put it in Needs you and will not execute it until Daniel approves.`
        : `${TEAM_BY_SLUG[agentId].name} owns job ${jobId}${args.parent_job_id ? ` as a concurrent follow-up to ${String(args.parent_job_id)}` : ""}. It is bound to this conversation, visible live in the command deck, and can run beside that specialist's other jobs on its own lease and checkout.`;
    }
    case "goal_mode": {
      const action = String(args.action ?? "status");
      const missionId = String(args.mission_id ?? "").trim();
      if (action === "status") {
        const missions: any[] = (await convexQuery("missions:active", {})) ?? [];
        const goal = missionId
          ? missions.find((mission) => String(mission._id) === missionId && mission.mode === "goal")
          : missions.find((mission) => mission.mode === "goal" && ["running", "split", "paused", "needs_input"].includes(mission.status));
        return goal
          ? `Goal ${goal._id} is ${goal.status}, phase ${goal.phase}, ${goal.percent}% complete${goal.failureReason ? ` — ${goal.failureReason}` : ""}. Its durable sessions and evidence are on screen.`
          : "There is no active Goal Mode outcome.";
      }
      if (action === "pause" || action === "resume" || action === "cancel" || action === "steer") {
        if (!missionId) return `Choose the Goal Mode outcome to ${action}.`;
        const input = action === "steer" ? String(args.input ?? "").trim() : undefined;
        if (action === "steer" && !input) return "Tell me the new direction for the unfinished Goal Mode nodes.";
        const ok = await convexMutation("goalMode:control", { id: missionId, action, input, authTokenHash });
        let shouldWake = action === "resume" || action === "steer";
        if (ok) {
          const { goalCoordinationDemand, syncExternalGoalControls, syncExternalGoalRevisions } = await import("../trigger/goal-runtime");
          await syncExternalGoalControls().catch(() => null);
          await syncExternalGoalRevisions().catch(() => null);
          if (action === "resume" || action === "steer") {
            const demand = await goalCoordinationDemand().catch(() => null);
            if (demand) shouldWake = demand.needed === true;
          }
        }
        if (ok && shouldWake) await wakeAgentFleet(`goal-resume:${missionId}`).catch(() => false);
        return ok ? `Goal Mode ${missionId} ${action} request applied.` : `That goal cannot be ${action}d from its current state.`;
      }
      if (action !== "start") return "Unknown Goal Mode action.";
      const goal = String(args.goal ?? "").trim();
      if (goal.length < 12) return "Tell me the concrete outcome Goal Mode must achieve.";
      const requestedSourceBranch = args.source_branch;
      if (requestedSourceBranch !== undefined && !isSafeSourceBranch(requestedSourceBranch)) {
        return "Explicit source branch is invalid; use an exact Git-safe branch name.";
      }
      const { routeGoal } = await import("./goal-mode");
      const route = routeGoal(goal, args.repo ? String(args.repo) : undefined);
      const protocolV2 = v2AdmissionEnabled();
      if (requestedSourceBranch !== undefined && !protocolV2) {
        return "Explicit source branch requires the v2 mission protocol; no mission was created.";
      }
      if (requestedSourceBranch !== undefined && !route.primaryRepo) {
        return "Explicit source branch requires a routed repository; no mission was created.";
      }
      if (protocolV2) {
        const readiness = cloudProviderAdmissionReadiness(process.env);
        if (!readiness.ready) {
          return `Goal Mode is temporarily unavailable because secure workspace readiness evidence is ${readiness.code.replaceAll("_", " ")}. No mission or Trigger worker was started; retry after the provider rollout is repaired.`;
        }
      }
      let projectAdmission: ProjectSourceAdmission | undefined;
      if (protocolV2) {
        try {
          projectAdmission = await resolveProjectSourceAdmission(route.primaryRepo, requestedSourceBranch);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Project source admission failed";
          return `Goal Mode did not create a mission because exact source admission failed: ${reason.slice(0, 240)}.`;
        }
      }
      const originThreadId = await activeThread();
      const created = await convexMutation(admissionMutationName("goal"), {
        authTokenHash,
        goal,
        route: route.kind,
        routeReason: route.reason,
        primaryRepo: projectAdmission?.repository ?? route.primaryRepo,
        ...(protocolV2 ? { projectAdmission } : {}),
        infrastructureContext: route.infrastructureContext,
        originThreadId,
        priority: 98,
        risk: "high",
        acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String).slice(0, 10) : undefined,
        maxBuildSessions: Number(args.build_sessions) || 6,
        maxRevisionWaves: Number(args.revision_waves) || 2,
      });
      const id = String(created?.missionId ?? "");
      if (!id) throw new Error("Goal Mode did not create a durable mission");
      if (!created?.held) await wakeAgentFleet(`goal:${id}`).catch(() => false);
      return created?.held
        ? `Goal Mode ${id} is durably held while the mission protocol rollout is dormant; no planner or repository workspace was started.`
        : `Goal Mode ${id} is live. Route: ${route.kind}${route.primaryRepo ? ` in ${route.primaryRepo}` : ""} — ${route.reason} One Sol/max planner is working now; it will route bounded work to the least expensive model that preserves its quality floor, save a durable checkpoint before every continuation, and only finish after a Sol/max deep validation passes.`;
    }
    case "orchestrate": {
      const mission = String(args.mission ?? "").trim();
      if (!mission) return "Give the supervisor the outcome the mission must achieve.";
      const supplied = (
        Array.isArray(args.agents) ? args.agents as unknown[] : []
      ).filter((candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" &&
        candidate !== null &&
        !Array.isArray(candidate) &&
        Boolean((candidate as Record<string, unknown>).task)
      ).slice(0, 6);
      const supervised = await startSupervisedOrchestrationIfSelected({
        mission,
        primaryRepo: args.repo ? String(args.repo) : undefined,
        context: args.context ? String(args.context) : undefined,
        acceptanceCriteria: Array.isArray(args.acceptance_criteria)
          ? args.acceptance_criteria.map(String).slice(0, 8)
          : undefined,
        requestedWorkstreams: supplied.map((candidate) => ({
          task:
            String(candidate.task) +
            (TASK_TEMPLATES[String(candidate.template ?? "")] ?? ""),
          label: candidate.label ? String(candidate.label) : undefined,
          repo: candidate.repo ? String(candidate.repo) : undefined,
          model: candidate.model ? String(candidate.model) : undefined,
          agentId: candidate.agent_id ? String(candidate.agent_id) : undefined,
          readonly:
            typeof candidate.readonly === "boolean"
              ? candidate.readonly
              : undefined,
          acceptanceCriteria: Array.isArray(candidate.acceptance_criteria)
            ? candidate.acceptance_criteria.map(String)
            : undefined,
        })),
        invocationContext,
        authTokenHash,
      }, {
        getOriginThreadId: activeThread,
        resolveProjectAdmissions: resolveMissionProjectAdmissions,
        mutate: convexMutation,
        dispatchWakeTicket: async (wakeTicket) => {
          const { dispatchMissionSupervisorWakeTicket } = await import(
            "./mission-supervisor-dispatch-server"
          );
          return await dispatchMissionSupervisorWakeTicket(wakeTicket);
        },
      });
      if (supervised) {
        const wakeStatus = supervised.wakeDispatched
          ? "Its durable supervisor wake is confirmed"
          : "Its durable supervisor is active; this replay did not need an additional wake";
        return `JARVIS ${supervised.replayed ? "resumed" : "started"} supervised mission ${supervised.missionId}${supervised.requestedWorkstreams ? ` with ${supervised.requestedWorkstreams} routed permanent-specialist workstream${supervised.requestedWorkstreams === 1 ? "" : "s"}` : ""}. ${wakeStatus}, live stages and checkpoints are on screen, and protected external actions still wait in Needs you.`;
      }
      const { planManagedMission } = await import("../mastra/supervisor");
      const plan: ManagedMission = await planManagedMission(mission, {
        repo: args.repo ? String(args.repo) : undefined,
        context: args.context ? String(args.context) : undefined,
        workstreams: supplied.map((a) => ({
          task: String(a.task),
          label: a.label ? String(a.label) : undefined,
          repo: a.repo ? String(a.repo) : undefined,
          model: a.model ? String(a.model) : undefined,
          agentId: a.agent_id ? String(a.agent_id) : undefined,
          readonly: typeof a.readonly === "boolean" ? a.readonly : undefined,
          acceptanceCriteria: Array.isArray(a.acceptance_criteria) ? a.acceptance_criteria.map(String) : undefined,
        })),
      });
      const originThreadId = await activeThread();
      const riskOrder = { low: 0, medium: 1, high: 2, consequential: 3 } as const;
      const missionRisk = plan.workstreams.reduce(
        (highest, stream) => (riskOrder[stream.risk] > riskOrder[highest] ? stream.risk : highest),
        "low" as keyof typeof riskOrder,
      );
      const protocolV2 = v2AdmissionEnabled();
      const projectAdmissions = protocolV2
        ? await resolveMissionProjectAdmissions(plan.workstreams.map((stream) => stream.repo))
        : [];
      const missionId = await convexMutation(admissionMutationName("mission"), {
        authTokenHash,
        goal: mission,
        agentCount: plan.workstreams.length,
        originThreadId,
        managerAgentId: "jarvis",
        priority: Math.max(...plan.workstreams.map((stream) => workModelPriority(stream.model))),
        risk: missionRisk,
        ...(protocolV2 ? { projectAdmissions } : {}),
        acceptanceCriteria: Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.map(String).slice(0, 8) : undefined,
      });
      for (const a of plan.workstreams) {
        const projectAdmission = protocolV2 ? admittedProject(projectAdmissions, a.repo) : undefined;
        const suppliedAgent = supplied.find((candidate) => String(candidate.task) === a.task);
        const scaffold = TASK_TEMPLATES[String(suppliedAgent?.template ?? "")] ?? "";
        const sharedContext = plan.context ? `\n\nShared mission context:\n${plan.context}` : "";
        await convexMutation(admissionMutationName("job"), {
          authTokenHash,
          task: `${a.task}${scaffold}${sharedContext}\n\nYou are ${a.agentId}, one permanent specialist on a ${plan.workstreams.length}-workstream mission: "${mission}". Own only this workstream, preserve the mission context, checkpoint useful progress, and stop only when the acceptance criteria are evidenced.`,
          repo: projectAdmission?.repository ?? a.repo,
          readonly: a.readonly,
          model: a.model,
          missionId: String(missionId),
          label: a.label,
          originThreadId,
          visibility: "conversation",
          agentId: a.agentId,
          risk: a.risk,
          priority: workModelPriority(a.model),
          approvalRequired: a.approvalRequired,
          acceptanceCriteria: a.acceptanceCriteria,
          modelReason: `${a.agentId} owns this Mastra-managed workstream; ${workModelLabel(a.model)} is the planned Codex execution tier`,
        });
      }
      if (plan.workstreams.some((stream) => !stream.approvalRequired)) {
        await wakeAgentFleet(`mission:${String(missionId)}`).catch(() => false);
      }
      const waiting = plan.workstreams.filter((stream) => stream.approvalRequired).length;
      return `JARVIS planned mission ${missionId} with ${plan.workstreams.length} permanent specialists: ${plan.workstreams.map((stream) => `${stream.label} [${workModelLabel(stream.model)}]`).join(", ")}. ${waiting ? `${waiting} consequential workstream${waiting === 1 ? " is" : "s are"} waiting in Needs you; ` : ""}live stages and checkpoints are on screen, and one reviewed synthesis returns to this conversation.`;
    }
    case "work_control": {
      const jobId = String(args.job_id ?? "");
      const action = String(args.action ?? "");
      if (!jobId) return "Choose a job from the command deck first.";
      if (action === "approve" || action === "decline") {
        const ok = await convexMutation("approvals:decide", {
          authTokenHash,
          jobId,
          decision: action === "approve" ? "approved" : "declined",
        });
        if (ok && action === "approve") await wakeAgentFleet(`approved:${jobId}`).catch(() => false);
        return ok
          ? action === "approve"
            ? "Approved. The workstream is queued; approval applies only to that scoped job."
            : "Declined. The job is cancelled and will not execute."
          : "That approval is no longer pending.";
      }
      if (action === "answer") {
        const answer = String(args.input ?? "").trim();
        if (!answer) return "Tell me the decision or missing information you want passed back to the agent.";
        const ok = await convexMutation("jobs:provideInput", { jobId, answer, authTokenHash });
        if (ok) await wakeAgentFleet(`continued:${jobId}`).catch(() => false);
        return ok ? "Passed that decision back to the specialist; the continuation is queued." : "That job is not waiting for input now.";
      }
      const input = action === "steer" ? String(args.input ?? "").trim() : undefined;
      if (action === "steer" && !input) return "Tell me the new direction you want the specialist to follow.";
      const ok = await convexMutation("jobs:control", { jobId, action, input, authTokenHash });
      if (ok && (action === "resume" || action === "retry" || action === "steer")) {
        await wakeAgentFleet(`${action}:${jobId}`).catch(() => false);
      }
      return ok ? `Job ${jobId} ${action} request applied.` : `That job cannot be ${action}d from its current state.`;
    }
    case "creative_sprint": {
      const brief = String(args.brief ?? "").trim();
      const output = String(args.output ?? "brainstorm");
      if (!brief) return "Give Atlas and Iris the creative challenge first.";
      return await executeTool("orchestrate", {
        mission: `Develop and visualize: ${brief}`,
        context: `Desired output: ${output}. Preserve the user's stated audience, constraints and taste.`,
        agents: [
          {
            label: "Atlas · directions",
            agent_id: "atlas",
            model: "terra",
            readonly: true,
            template: "research_report",
            task: `Develop 3 genuinely distinct creative directions for this brief: ${brief}. For each, give the core idea, audience logic, reference territory, risks, and what would make it visually unmistakable. Recommend one without flattening the alternatives.`,
            acceptance_criteria: ["Three meaningfully different directions", "A clear recommendation with trade-offs"],
          },
          {
            label: "Iris · visual system",
            agent_id: "iris",
            model: "terra",
            readonly: true,
            task: `Turn this brief into a production-ready ${output} system: ${brief}. Specify composition, visual hierarchy, palette, typography or mark-making, scene/shot structure where relevant, and final image-generation or drawing prompts. Include an editable construction plan, not only adjectives.`,
            acceptance_criteria: ["Production-ready visual specification", "Editable construction steps and exact generation/drawing prompts"],
          },
        ],
      }, boundedHostContext);
    }
    case "visual_scene":
      return await visualSceneTool(args, invocationContext);
    case "show": {
      let { kind, value, title } = args as { kind?: string; value: string; title?: string };
      value = String(value ?? "").trim();
      if (kind === "list") {
        const items = (Array.isArray(args.items) ? args.items : []).slice(0, 40).map((item: any, index: number) => ({
          id: String(item?.id ?? `item-${index + 1}`).slice(0, 80),
          label: String(item?.label ?? "").trim().slice(0, 180),
          detail: item?.detail ? String(item.detail).slice(0, 500) : undefined,
          status: item?.status ? String(item.status).slice(0, 60) : undefined,
          value: typeof item?.value === "number" ? item.value : item?.value ? String(item.value).slice(0, 80) : undefined,
          icon: item?.icon ? String(item.icon).slice(0, 8) : undefined,
          group: item?.group ? String(item.group).slice(0, 80) : undefined,
          href: item?.href && /^https?:\/\//.test(String(item.href)) ? String(item.href).slice(0, 1_000) : undefined,
          checked: Boolean(item?.checked),
        })).filter((item: any) => item.label);
        if (!items.length) return "Nothing to show — add at least one labelled list item.";
        title = String(title ?? "Structured list").slice(0, 120);
        value = JSON.stringify({ title, subtitle: args.subtitle ? String(args.subtitle).slice(0, 300) : undefined, ordered: Boolean(args.ordered), items });
        const filing = await creationFiling(args, "lists");
        const existing: any = await convexQuery("creations:latest", { kind: "list", titleMatch: title.toLowerCase() }).catch(() => null);
        if (existing?._id) await convexMutation("creations:update", { id: existing._id, title, data: value, ...filing });
        else await convexMutation("creations:create", { kind: "list", title, data: value, ...filing });
      }
      if (!value) return "Nothing to show — give me a URL, image, code, text or list items.";
      // Models omit/confuse `kind` — infer and normalize so it always renders.
      const id = YT_ID(value);
      if (id) {
        kind = "video";
        // jsapi enabled so video_control can drive it; autoplay when he asked to play
        value = `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0${args.play ? "&autoplay=1" : ""}`;
      } else if (!kind || !["url", "video", "image", "code", "markdown", "site", "list"].includes(kind)) {
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
        value: kind === "list" ? String(value) : String(value).slice(0, 4000),
        title: title ? String(title) : undefined,
      }).catch(() => {});
      return "On screen now.";
    }
    case "show_ranking":
      return await showRanking(args);
    case "rank_focus":
      return await rankFocus(args);
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
    case "remind_at": {
      const rtext = String(args.text ?? "").trim();
      if (!rtext) return "TOOL DID NOTHING: no reminder text.";
      let at = 0;
      if (args.in_minutes && Number(args.in_minutes) > 0) at = Date.now() + Number(args.in_minutes) * 60_000;
      else if (args.at_iso) at = Date.parse(String(args.at_iso));
      if (!at || Number.isNaN(at)) return "TOOL DID NOTHING: pass at_iso (ISO datetime) or in_minutes.";
      if (at < Date.now() - 60_000) return "TOOL DID NOTHING: that time is in the past — recompute at_iso.";
      await convexMutation("reminders:add", { text: rtext, at, originThreadId: await activeThread() });
      const when = new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
      return `Reminder set: "${rtext}" at ${when} (delivery within ~2 min of the mark — push + spoken). Confirm to Daniel in a few words.`;
    }
    case "reminder_cancel": {
      const hit = await convexMutation("reminders:cancel", { match: String(args.match ?? "") });
      return hit ? `Cancelled: "${hit}".` : "TOOL DID NOTHING: no pending reminder matches that.";
    }
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
    case "bookings_lookup":
      return await bookingsLookup(args);
    case "bookings_check":
      return await bookingsCheck(args);
    case "open_app":
      return await openApp(args);
    case "host_ui":
      return await hostUi(args);
    case "mac_shortcut": {
      const shortcut = String(args.shortcut ?? "").trim().slice(0, 120);
      if (!shortcut) return "TOOL DID NOTHING: name the installed Apple Shortcut.";
      const input = String(args.input ?? "").trim().slice(0, 4000);
      const reason = String(args.reason ?? "").trim().slice(0, 300);
      await showWidget({ kind: "mac_action", shortcut, input, reason }, `Mac · ${shortcut}`);
      return `The Mac action “${shortcut}” is ready on screen. It has not run; Daniel must click Run on this Mac.`;
    }
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
      return await mindMap(args, invocationContext);
    case "chart":
      return await chartTool(args, invocationContext);
    case "price_chart":
      return await priceChartTool(args);
    case "market_analysis":
      return await marketAnalysisTool(args);
    case "trip_open": {
      const { openTrip } = await import("./travel");
      const destination = String(args.destination ?? "").trim();
      if (!destination) return "Which destination?";
      const { id, doc } = await openTrip({ destination, destIata: args.dest_iata ? String(args.dest_iata) : undefined });
      return `Trip ${id} is up on the globe, centred on ${destination}${doc.airport ? ` (${doc.airport.name} marked)` : ""}. It fills in live as you plan; use this exact trip_id for trip_plan and every later edit.`;
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
      const mood = ["calm", "focused", "dreamy", "warm", "tender", "playful", "curious", "serious", "alert", "excited"].includes(String(args.mood)) ? String(args.mood) : "calm";
      await convexMutation("ui:setMood", { mood });
      return `Mood set: ${mood}. (Say nothing about it — it just happens.)`;
    }
    case "news_today":
      return await newsToday(args);
    case "music_search":
      return await musicSearch(args);
    case "transport_route":
      return await transportRoute(args);
    case "travel_map":
      return await travelMap(args);
    case "places_near":
      return await placesNear(args);
    case "memory_map":
      return await memoryMapTool(args);
    case "price_watch": {
      const q = String(args.query ?? "").trim();
      if (!q) return "TOOL DID NOTHING: what should I watch?";
      const [{ observeProduct }, ebay, serper, serpapi] = await Promise.all([
        import("./product-observation"),
        getServiceSecrets("ebay").catch(() => ({} as Record<string, string>)),
        getServiceSecrets("serper").catch(() => ({} as Record<string, string>)),
        getServiceSecrets("serpapi").catch(() => ({} as Record<string, string>)),
      ]);
      const requestedCondition = ["new", "used"].includes(String(args.condition))
        ? String(args.condition)
        : "any";
      const now = await observeProduct(
        q,
        {
          ebayClientId: ebay.EBAY_CLIENT_ID,
          ebayClientSecret: ebay.EBAY_CLIENT_SECRET,
          serperApiKey: serper.SERPER_API_KEY,
          serpApiKey: serpapi.SERPAPI_KEY,
        },
        undefined,
        requestedCondition,
      ).catch(() => null);
      const tgt = Number(args.target_gbp) || 0;
      const watchId = await convexMutation("watchRules:createProduct", {
        query: q,
        targetPence: tgt ? Math.round(tgt * 100) : undefined,
        condition: requestedCondition,
        initialObservation: now ?? undefined,
        originThreadId: await activeThread(),
      });
      return now
        ? `Durable hunt ${watchId} is active for "${q}". Best verified match is £${(now.landedPence / 100).toFixed(2)} ${now.deliveryKnown ? "landed" : "listed (delivery still unverified)"} via ${now.source.provider}${tgt ? `; I'll alert only on a verified landed-price crossing below £${tgt}` : "; I'll alert after a verified meaningful new landed-price low"}. Never buys automatically.`
        : `Durable hunt ${watchId} is active for "${q}"${tgt ? ` below £${tgt}` : ""}. No trustworthy identity match was available this second, so the scheduler will retry without fabricating a baseline.`;
    }
    case "price_alert": {
      const asset = String(args.asset ?? "").trim();
      const threshold = Number(args.threshold);
      const operator = args.operator === "below" ? "below" : "above";
      if (!asset || !Number.isFinite(threshold) || threshold <= 0) return "TOOL DID NOTHING: asset and a positive threshold are required.";
      const { resolveAsset, fetchCandles } = await import("./markets");
      const ref = resolveAsset(asset);
      if (!ref) return `TOOL DID NOTHING: I couldn't map the asset "${asset}" to a supported market symbol.`;
      const interval = ["1m", "5m", "1h", "4h", "1d", "1w"].includes(String(args.interval)) ? String(args.interval) : "1h";
      const candles = await fetchCandles(ref, ["1h", "4h", "1d", "1w"].includes(interval) ? interval : "1h", 3).catch(() => []);
      const latest = candles.at(-1);
      const provider = ref.binance ? "binance" : "finnhub";
      const currency = String(args.currency ?? (ref.binance ? "USDT" : "USD"));
      const initialObservation = latest ? {
        symbol: ref.binance ?? ref.yahoo,
        price: latest.c,
        currency,
        source: {
          provider: ref.binance ? "Binance" : "Yahoo Finance",
          feed: "chart-baseline",
          tier: ref.binance ? "official" : "aggregator",
          latency: ref.binance ? "current" : "unknown",
          observedAt: latest.t,
          receivedAt: Date.now(),
          freshUntil: Date.now() + 5 * 60_000,
        },
      } : undefined;
      const watchId = await convexMutation("watchRules:createAsset", {
        symbol: ref.binance ?? ref.yahoo ?? asset.toUpperCase(),
        provider,
        interval,
        operator,
        threshold,
        currency,
        initialObservation,
        originThreadId: await activeThread(),
      });
      await priceChartTool({ asset, interval: ["1h", "4h", "1d", "1w"].includes(interval) ? interval : "1h" }).catch(() => {});
      return `Chart alert ${watchId} is active: ${ref.label} ${operator} ${threshold} ${currency}. It fires once on a genuine crossing, rearms with hysteresis, and cannot place a trade.`;
    }
    case "watch_list": {
      const existing: any = await convexQuery("creations:latest", { kind: "scene", titleMatch: "price hunts" }).catch(() => null);
      if (existing?._id) await convexMutation("ui:setPanel", { type: "scene", value: JSON.stringify({ creationId: String(existing._id) }), title: "visual · Price hunts & signals" });
      else await visualSceneTool({ action: "create", title: "Price hunts & signals", subtitle: "Verified products, true asset crossings and source freshness", capability: "price_hunts" });
      const rules: any[] = (await convexQuery("watchRules:list", { status: "active", limit: 40 }).catch(() => [])) ?? [];
      const events: any[] = (await convexQuery("watchRules:openEvents", { limit: 20 }).catch(() => [])) ?? [];
      return `${rules.length} active watch${rules.length === 1 ? "" : "es"} and ${events.length} open signal${events.length === 1 ? "" : "s"} are live on screen.`;
    }
    case "watch_cancel": {
      const hit = await convexMutation("watchRules:cancel", { match: String(args.match ?? "") });
      return hit ? `Stopped watching "${hit}".` : "TOOL DID NOTHING: no active watch matches that.";
    }
    case "shop_search":
      return await shopSearch(args);
    case "draft":
      return await draftDoc(args);
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
      const { safeMemoryNote } = await import("./memory-safety");
      const note = safeMemoryNote(args.title, args.body);
      if (!note) return "I won't save credentials or likely secrets to memory. Store them in the credential vault instead.";
      const project = args.project ? String(args.project).slice(0, 50) : undefined;
      await convexMutation("memory:write", {
        kind: String(args.kind ?? "fact"),
        title: note.title,
        body: note.body,
        tags: [...(Array.isArray(args.tags) ? args.tags.map(String) : []), ...(project ? [project] : [])].slice(0, 6),
      });
      const { vaultWrite } = await import("./obsidian");
      await vaultWrite(String(args.kind ?? "fact"), note.title, note.body, project);
      return project ? `Saved to memory (filed under project ${project}).` : "Saved to memory.";
    }
    case "project_goal":
      return await projectGoalTool(args);
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
      const protocolV2 = v2AdmissionEnabled();
      const [projectAdmission] = protocolV2 ? await resolveMissionProjectAdmissions([app ?? "jarvis"]) : [undefined];
      const originThreadId = await activeThread();
      const incidentId = await convexMutation("incidents:report", {
        source: "brain",
        app,
        signature: `brain:${problem.slice(0, 100)}`,
        message: problem,
      });
      // Dispatch immediately — don't wait for the healer sweep.
      await convexMutation("incidents:setStatus", { id: incidentId, status: "dispatched" }).catch(() => {});
      const missionId = await convexMutation(admissionMutationName("mission"), {
        authTokenHash,
        goal: `Repair ${problem}`.slice(0, 500),
        agentCount: 1,
        ...(protocolV2 ? { mode: "single", projectAdmissions: [projectAdmission!] } : {}),
        originThreadId,
        managerAgentId: "jarvis",
        priority: 95,
        risk: "high",
      });
      await convexMutation(admissionMutationName("job"), {
        authTokenHash,
        task:
          `SELF-REPAIR: trace the ROOT CAUSE and fix it — never paper over symptoms. Daniel reports: ${problem}\n` +
          `Method: 1) REPRODUCE (hit live endpoints, read the failing path). 2) Trace to the underlying cause. ` +
          `3) Minimal correct fix. 4) VALIDATE: 'npm install' + 'npx tsc --noEmit' must pass; 'npm run build' must pass for app code. ` +
          `5) Commit only working code ("self-repair: ..."). ${SHALLOW_PROVENANCE_RULE} Never replace or reparent a persisted shared branch based on a truncated revision walk. ` +
          `If it needs convex/ or src/trigger/ redeploy, commit and say so plainly.`,
        repo: projectAdmission?.repository ?? app ?? "jarvis",
        missionId: String(missionId),
        model: "sol",
        incidentId: String(incidentId),
        originThreadId,
        visibility: "conversation",
        agentId: "paul",
        risk: "high",
        priority: 95,
        acceptanceCriteria: [
          "Reproduce the reported failure",
          "Trace and repair the root cause on an isolated branch",
          "Run relevant typecheck/tests/build",
          "Verify the actual user-visible or provider surface",
        ],
        modelReason: "Paul + Sol: production repair requires deep Codex engineering and verification",
        label: `Paul · repair ${problem.slice(0, 48)}`,
      });
      await wakeAgentFleet(`repair:${String(incidentId)}`).catch(() => false);
      return "Paul owns the repair on an isolated branch. He'll reproduce it and verify the fix; the delivery controller will merge it automatically once the evidence and repository checks pass.";
    }
    case "self_improve": {
      const request = String(args.request ?? "").slice(0, 1500);
      if (!request) return "Tell me what ability to build first.";
      const protocolV2 = v2AdmissionEnabled();
      const [projectAdmission] = protocolV2 ? await resolveMissionProjectAdmissions(["jarvis"]) : [undefined];
      const originThreadId = await activeThread();
      const missionId = await convexMutation(admissionMutationName("mission"), {
        authTokenHash,
        goal: `Improve JARVIS: ${request}`.slice(0, 500),
        agentCount: 1,
        ...(protocolV2 ? { mode: "single", projectAdmissions: [projectAdmission!] } : {}),
        originThreadId,
        managerAgentId: "jarvis",
        priority: 80,
        risk: "high",
      });
      await convexMutation(admissionMutationName("job"), {
        authTokenHash,
        task: `${SELF_IMPROVE_RULES}\n\nThe upgrade Daniel wants: ${request}`,
        repo: projectAdmission?.repository ?? "jarvis",
        missionId: String(missionId),
        model: "sol",
        originThreadId,
        visibility: "conversation",
        agentId: "paul",
        risk: "high",
        priority: 80,
        acceptanceCriteria: ["Connected implementation, not placeholder UI", "Typecheck/tests/build pass", "Verified repository delivery completes without a manual approval"],
        modelReason: "Paul + Sol: JARVIS self-modification is complex Codex engineering",
        label: `Paul · upgrade ${request.slice(0, 46)}`,
      });
      await wakeAgentFleet("self-improve").catch(() => false);
      return "Paul has the upgrade on an isolated branch with validation gates; verified delivery will complete automatically and progress is live in the command deck.";
    }
    case "agent_status": {
      const [active, recent, missions, team, attention, approvals] = await Promise.all([
        convexQuery("jobs:active", {}),
        convexQuery("findings:recent", { limit: 4 }),
        convexQuery("missions:active", { includeJobs: true }).catch(() => []),
        convexQuery("agents:list", {}).catch(() => []),
        convexQuery("attention:list", { status: "open", limit: 5 }).catch(() => []),
        convexQuery("approvals:pending", {}).catch(() => []),
      ]);
      const m = Array.isArray(missions) && missions.length
        ? "Missions: " +
          missions
            .map((x: any) => `"${x.goal.slice(0, 60)}" [${x.status}] ${x.jobs.filter((j: any) => j.status === "done").length}/${x.jobs.length} agents done`)
            .join("; ") + "\n"
        : "";
      const a = Array.isArray(active) && active.length
        ? "Work: " + active.map((j: any) => `${j._id} · ${j.agentId ?? "agent"} · "${(j.label ?? j.task).slice(0, 60)}" — ${j.stage ?? j.status} ${j.percent ?? 0}%${(j.attempt ?? 1) > 1 ? ` (attempt ${j.attempt})` : ""}`).join("; ")
        : "No agents running.";
      const roster = Array.isArray(team) && team.length
        ? "\nPermanent team: " + team.map((member: any) => `${member.name} (${member.role})=${member.status}`).join("; ")
        : "";
      const needs = Array.isArray(approvals) && approvals.length
        ? `\nNeeds Daniel: ${approvals.map((item: any) => `${item.jobId} · ${item.summary}`).join("; ")}`
        : "";
      const priorities = Array.isArray(attention) && attention.length
        ? `\nAttention: ${attention.map((item: any) => `${item.title} [impact ${item.impact}, urgency ${item.urgency}, confidence ${Math.round(item.confidence * 100)}%]`).join("; ")}`
        : "";
      const f = Array.isArray(recent) && recent.length
        ? "\nRecent findings: " + recent.map((r: any) => r.spoken).join(" | ")
        : "";
      return m + a + roster + needs + priorities + f;
    }
    case "calculate": {
      const raw = String(args.expression ?? "").trim();
      if (!raw) return "TOOL DID NOTHING: no expression.";
      // Safe evaluator: whitelist arithmetic + a few Math fns, reject anything else.
      const expr = raw
        .replace(/\bpi\b/gi, "Math.PI").replace(/\be\b/g, "Math.E")
        .replace(/\b(sqrt|round|abs|min|max|pow|floor|ceil|log|sin|cos|tan)\s*\(/gi, (_m, f) => `Math.${f.toLowerCase()}(`)
        .replace(/×/g, "*").replace(/÷/g, "/").replace(/[£$€,]/g, "");
      if (!/^[\d\s+\-*/%.()MathPIEsqrtoundabsminxpowfilcegltn]*$/.test(expr))
        return "TOOL DID NOTHING: that expression has characters I won't evaluate — simplify it to plain arithmetic.";
      let result: number;
      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        result = Function(`"use strict"; return (${expr});`)() as number;
      } catch {
        return "TOOL DID NOTHING: couldn't parse that calculation.";
      }
      if (typeof result !== "number" || !Number.isFinite(result)) return "That doesn't come out to a finite number.";
      const pretty = Number.isInteger(result) ? result.toLocaleString("en-GB") : result.toLocaleString("en-GB", { maximumFractionDigits: 6 });
      await showWidget({ kind: "calc", label: String(args.label ?? "").slice(0, 60), expression: raw, result: pretty }, `= ${pretty}`);
      return `Calculation on screen: ${raw} = ${pretty}. Say the answer in one short line.`;
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
  });
}
