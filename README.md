# JARVIS

JARVIS is Daniel's voice-and-text AI assistant and autonomous engineering brain — a
Next.js app deployed on Vercel that talks, thinks, remembers, and dispatches background
agents to build and repair Daniel's other projects. One personality
(`src/lib/persona.ts`) drives everything.

## Two-lane brain

- **Live lane** — `/api/realtime-token` mints an ephemeral OpenAI Realtime client secret
  (persona + fresh context + tool defs baked in). The browser (`src/lib/realtime.ts`)
  connects straight to OpenAI over WebRTC, with native VAD, barge-in, and speech. Tools
  run through `/api/tools`; finished turns mirror into Convex history.
- **Text lane** — `/api/chat` answers every typed or mic turn in seconds on Groq
  (`gpt-oss-120b`, falling back to `llama-3.3`) using the same tool belt
  (`src/lib/tools.ts`) and streaming into Convex. Replies are spoken by ElevenLabs via
  `/api/tts` (Kokoro fallback). If the route fails, the turn re-queues as `pending` and a
  Trigger cron dispatcher (`src/trigger/chat-session.ts`) picks it up.

## Supporting systems

- **Cortex** — background Claude Code agents on Trigger.dev
  (`src/trigger/agent-runner.ts`, cron every 2 min). The brain enqueues jobs
  (`jobs:enqueue`), each agent gets a briefing with the infra map and repo access, and
  results are woven back as a single spoken line plus a `findings` row.
- **Memory** — a Convex `memory` table injected per turn, with post-turn extraction in
  `/api/chat`, consolidated every 6h into the git-backed Obsidian vault `jarvis-memory`
  (`src/trigger/memory-vault.ts`).
- **Screen** — `ui:setPanel` (url | video | image | code | markdown) drives the
  materializing viewport in `src/components/JarvisUI.tsx`.
- **Self-maintenance** — the brain's `self_repair` and `self_improve` tools, plus
  automatic incident reports, dispatch root-cause repair and engineering agents; validated
  commits to `main` auto-deploy via Vercel.

## Development

```bash
npm install
npm run dev
```

Deploy: push to `main` → Vercel. `npx convex deploy` for `convex/`;
`npx trigger.dev deploy` for `src/trigger/`. Missing env vars are pulled from the secrets
vault at runtime (`src/lib/vault.ts`).

See [`AGENTS.md`](./AGENTS.md) for the full architecture and self-modification checklist.
