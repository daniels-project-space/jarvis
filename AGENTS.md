<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# JARVIS — architecture

Two-lane brain, one personality (`src/lib/persona.ts`):

- **Live lane** — `/api/realtime-token` mints an ephemeral OpenAI Realtime client secret (persona + fresh context + tool defs baked in); the browser (`src/lib/realtime.ts`) connects to OpenAI directly over WebRTC. Native VAD, barge-in, speech. Tools execute via `/api/tools`; finished turns mirror into Convex history.
- **Text lane** — `/api/chat` answers every typed/mic turn in seconds on Groq (gpt-oss-120b → llama-3.3 fallback) with the same tool belt (`src/lib/tools.ts`), streaming into Convex. Replies are spoken by ElevenLabs via `/api/tts` (Kokoro fallback). If the route fails, the turn re-queues as `pending` and the old Trigger cron dispatcher (`src/trigger/chat-session.ts`) answers it.
- **Cortex** — switchable Codex or Claude Code subscription agents on Trigger.dev (`src/trigger/agent-runner.ts`, cron */2). Daniel selects the provider globally in Options. The brain dispatches jobs (`jobs:enqueue`, optional repo + `mcp: [browserbase|context7]`). Agents get an infra/vault briefing and results are WOVEN, never dumped: one short spoken line into chat + a `findings` row the brain can pull up or show on the panel.
- **Memory** — Convex `memory` table (fast recall, injected per turn) + post-turn extraction in `/api/chat`; consolidated every 6h into the git-backed Obsidian vault `daniels-project-space/jarvis-memory` (`src/trigger/memory-vault.ts`).
- **Screen** — `ui:setPanel` (types: url/site | video | image | code | markdown | widget | canvas | launch | pdf | creations) drives the materializing viewport in `JarvisUI.tsx` (rich views live in `Views.tsx`); both the brain (`show` tool) and agents can set it. Chat has three modes (full column / floating type bar / hidden "zen" with the wake word forced on); content-heavy panels auto-collapse the chat to the bar.
- **Actions** — the hub to-do list and calendar are WRITABLE (`todo_add`/`todo_done`/`todo_remove`, `calendar_add`/`calendar_remove` → project-hub Convex `fantastic-roadrunner-485`); `open_app` launches Daniel's apps; `calendar_view` renders the frosted-glass day/week/month widget.
- **Atelier** — everything JARVIS creates persists in the Convex `creations` table and shows in the library panel: `mind_map` (live-editable canvas), `chart`, `create_image` (Novita Z-Image Turbo, key in vault service `novita`), `create_pdf` (`src/lib/pdf.ts`), `store_image`. Artifacts live in the R2 bucket `jarvis` (public domain `pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev`, creds in vault service `cloudflare`, helper `src/lib/r2.ts`).
- **Judgement** — `research` (multi-angle search + top-source read, cross-checked) for facts that matter; `deliberate` (OpenAI reasoning model) for hard design/creative/strategy calls.
- **Embed** — `/embed` + `public/jarvis-embed.js` put a mini orb (wake word on by default) on the project hub and any internal app; same brain and threads.

- **Self-maintenance** — the brain's `self_repair` tool (and automatic incident reports from routes, the client, and the stack poller into the Convex `incidents` table) dispatch root-cause repair agents via the healer sweep in `agent-runner.ts` (attempt-capped at 2, then escalates to Daniel). `self_improve` dispatches an engineer on this repo to add capabilities/UI; Vercel auto-deploys validated commits.

## Self-modification checklist (for agents editing this repo)
1. New ability = tool in `src/lib/tools.ts` (TOOL_DEFS + executeTool — both lanes pick it up), route in `src/app/api/`, or UI in `src/components/JarvisUI.tsx`. Keep the design language (cockpit HUD, cyan/amber, Chakra Petch/Sora).
2. Validate before committing: `npm install`, then `npx tsc --noEmit` and `npm run build` must both pass. Never commit broken code.
3. `convex/` and `src/trigger/` changes do NOT deploy from here (need VPS `npx convex dev --once` / `npx trigger.dev deploy`) — avoid when possible, otherwise say so plainly in your final answer.
4. Never remove existing capabilities; commit messages start `self-repair:` or `self-improve:`.

Deploy: push to main → Vercel. `npx convex deploy` for convex/. `npx trigger.dev deploy` for src/trigger/ (project `jarvis-jobs`, needs `TRIGGER_ACCESS_TOKEN`). Env on Vercel: GROQ_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, SERPAPI_KEY, REPLICATE_API_TOKEN, NEXT_PUBLIC_CONVEX_URL (+ VAPID keys for push). Anything missing is pulled from the secrets vault at runtime (`src/lib/vault.ts`).
