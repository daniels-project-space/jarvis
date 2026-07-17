<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# JARVIS — architecture

Two-lane brain, one personality (`src/lib/persona.ts`):

- **Live lane** — turn-taking browser audio uses free Whisper transcription, the same subscription-backed Codex app-server as text, and local Kokoro TTS. The microphone stays closed while Jarvis speaks, preventing self-echo cut-offs. Tools execute via `/api/tools`; finished turns live in Convex history.
- **Text lane** — `/api/chat` commits every typed/mic turn to Convex and wakes one of two warm Trigger workers. A persistent Codex app-server authenticated by Daniel's subscription streams deltas to Convex; Luna/Terra/Sol are selected by complexity. The minute dispatcher is a sub-second lease health check; it never runs the long-lived conversation loop itself.
- **Cortex** — permanent subscription agents run through the pinned Codex CLI harness on isolated GitHub cloud runners (`.github/workflows/jarvis-agent-harness.yml`). Convex owns leases/checkpoints; Vercel sends immediate workflow wakes on dispatch, approval, and continuation. Trigger does not execute specialist intelligence. The brain dispatches jobs (`jobs:enqueue`, optional repo + `mcp: [browserbase|context7]`). Results are WOVEN, never dumped: one short spoken line into chat + a `findings` row the brain can pull up or show on the panel.
- **Memory** — Convex `memory` table (fast recall, injected per turn) + post-turn extraction in `/api/chat`; consolidated every 6h into the git-backed Obsidian vault `daniels-project-space/jarvis-memory` (`src/trigger/memory-vault.ts`).
- **Screen** — `ui:setPanel` (types: url/site | video | image | code | markdown | widget | canvas | launch | pdf | creations) drives the materializing viewport in `JarvisUI.tsx` (rich views live in `Views.tsx`); both the brain (`show` tool) and agents can set it. Chat has three modes (full column / floating type bar / hidden "zen" with the wake word forced on); content-heavy panels auto-collapse the chat to the bar.
- **Actions** — the hub to-do list and calendar are WRITABLE (`todo_add`/`todo_done`/`todo_remove`, `calendar_add`/`calendar_remove` → project-hub Convex `fantastic-roadrunner-485`); `open_app` launches Daniel's apps; `calendar_view` renders the frosted-glass day/week/month widget.
- **Atelier** — everything JARVIS creates persists in the Convex `creations` table and shows in the library panel: `mind_map` (live-editable canvas), `chart`, `create_image` (Novita Z-Image Turbo, key in vault service `novita`), `create_pdf` (`src/lib/pdf.ts`), `store_image`. Artifacts live in the R2 bucket `jarvis` (public domain `pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev`, creds in vault service `cloudflare`, helper `src/lib/r2.ts`).
- **Judgement** — `research` gathers sourced facts; hard design/creative/strategy calls use the active Codex subscription supervisor, never a metered OpenAI API fallback.
- **Embed** — `/embed` + `public/jarvis-embed.js` put a mini orb (wake word on by default) on the project hub and any internal app; same brain and threads.

- **Self-maintenance** — the brain's `self_repair` tool (and automatic incident reports from routes, the client, and the stack poller into the Convex `incidents` table) dispatch root-cause repair agents through the CLI harness healer sweep (attempt-capped at 2, then escalates to Daniel). `self_improve` dispatches an engineer on this repo to add capabilities/UI; Vercel auto-deploys validated commits.

## Self-modification checklist (for agents editing this repo)
1. New ability = tool in `src/lib/tools.ts` (TOOL_DEFS + executeTool — both lanes pick it up), route in `src/app/api/`, or UI in `src/components/JarvisUI.tsx`. Keep the design language (cockpit HUD, cyan/amber, Chakra Petch/Sora).
2. Validate before committing: `npm install`, then `npx tsc --noEmit` and `npm run build` must both pass. Never commit broken code.
3. `convex/` and `src/trigger/` changes require separate provider deploys. Jarvis's canonical live data deployment is `tangible-goose-318`, so run `npx convex dev --once` for that target and mirror schema changes with `npx convex deploy --yes`; then run `npx trigger.dev deploy`. Verify the exact live deployment rather than assuming codegen or a Vercel build published functions.
4. Never remove existing capabilities; commit messages start `self-repair:` or `self-improve:`.

Deploy: push to main → Vercel. `npx convex dev --once` publishes the canonical live Convex target; `npx convex deploy --yes` mirrors its schema to the formal production target. `CONVEX_URL=https://tangible-goose-318.convex.cloud npx trigger.dev deploy` publishes Trigger tasks to Jarvis's isolated project. Foreground intelligence uses Codex subscription auth in Trigger; metered OpenAI API access is forbidden. Vercel utilities use GROQ_API_KEY, SERPAPI_KEY, REPLICATE_API_TOKEN, NEXT_PUBLIC_CONVEX_URL (+ VAPID keys for push). Anything missing is pulled from the secrets vault at runtime (`src/lib/vault.ts`).
