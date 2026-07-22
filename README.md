# JARVIS

JARVIS is Daniel's voice-and-text AI assistant and autonomous engineering brain — a
Next.js app deployed on Vercel that talks, thinks, remembers, and dispatches background
agents to build and repair Daniel's other projects. One personality
(`src/lib/persona.ts`) drives everything.

## Two-lane brain

- **Live lane** — turn-taking browser audio → free Whisper transcription → a warm,
  streaming Codex app-server authenticated by Daniel's subscription → the authenticated
  Edge neural Ryan voice route. Short MP3 segments are decoded in the browser with no
  local model download or inference warm-up. The microphone is closed while Jarvis
  speaks, so speaker echo cannot cut him off.
  Tools run through the private agent bridge; finished turns live in Convex history.
- **Text lane** — `/api/chat` commits each turn to Convex and wakes the available
  long-lived foreground owner. The primary and handoff Trigger tasks alternate
  only at the four-hour handoff boundary; exactly one holds the Convex lease.
  The same Codex subscription app-server streams deltas every 120 ms;
  Luna/Terra/Sol are selected by complexity. The minute dispatcher only checks the
  runner lease and starts a replacement; it never occupies the recovery queue.

## Supporting systems

- **Cortex** — background subscription agents on Trigger.dev
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
