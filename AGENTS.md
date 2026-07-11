<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# JARVIS — architecture

Two-lane brain, one personality (`src/lib/persona.ts`):

- **Live lane** — `/api/realtime-token` mints an ephemeral OpenAI Realtime client secret (persona + fresh context + tool defs baked in); the browser (`src/lib/realtime.ts`) connects to OpenAI directly over WebRTC. Native VAD, barge-in, speech. Tools execute via `/api/tools`; finished turns mirror into Convex history.
- **Text lane** — `/api/chat` answers every typed/mic turn in seconds on Groq (gpt-oss-120b → llama-3.3 fallback) with the same tool belt (`src/lib/tools.ts`), streaming into Convex. Replies are spoken by ElevenLabs via `/api/tts` (Kokoro fallback). If the route fails, the turn re-queues as `pending` and the old Trigger cron dispatcher (`src/trigger/chat-session.ts`) answers it.
- **Cortex** — background Claude Code agents on Trigger.dev (`src/trigger/agent-runner.ts`, cron */2). The brain dispatches jobs (`jobs:enqueue`, optional repo + `mcp: [browserbase|context7]`). Agents get a briefing CLAUDE.md (infra map + secrets-vault curl access + all repos via GITHUB_TOKEN). Results are WOVEN, never dumped: one haiku-written spoken line into chat + a `findings` row the brain can pull up or show on the panel.
- **Memory** — Convex `memory` table (fast recall, injected per turn) + post-turn extraction in `/api/chat`; consolidated every 6h into the git-backed Obsidian vault `daniels-project-space/jarvis-memory` (`src/trigger/memory-vault.ts`).
- **Screen** — `ui:setPanel` (types: url | video | image | code | markdown) drives the materializing viewport in `JarvisUI.tsx`; both the brain (`show` tool) and agents can set it.

Deploy: push to main → Vercel. `npx convex deploy` for convex/. `npx trigger.dev deploy` for src/trigger/ (project `jarvis-jobs`, needs `TRIGGER_ACCESS_TOKEN`). Env on Vercel: GROQ_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, SERPAPI_KEY, REPLICATE_API_TOKEN, NEXT_PUBLIC_CONVEX_URL (+ VAPID keys for push). Anything missing is pulled from the secrets vault at runtime (`src/lib/vault.ts`).
