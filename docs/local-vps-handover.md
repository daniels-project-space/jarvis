# Local VPS Codex ↔ Claude handover

This is the local, SSH/VPS control path for explicitly managed coding sessions.
It is separate from Jarvis's Trigger/Codex runtime and never copies a Codex or
Claude login, exposes an inbound port, or falls back to billed API access.

## What happens automatically

`jarvis-local-handover.service` is a small non-AI supervisor. Every poll it:

1. reads the owner-selected target from the paired Jarvis runner endpoint;
2. probes Codex with the documented local app-server `account/rateLimits/read`
   JSON-RPC request (not a model turn);
3. when a verified weekly Codex bucket has one percent remaining, changes the
   persisted target from Codex to Claude and prepares a fresh Claude
   continuation for every registered managed session; and
4. publishes only compact health/count/quota facts back to the Project Hub.

If an original managed tmux session is still running, its replacement waits
until that session exits. This prevents two agents from editing the same
checkout concurrently. At a quota stop, the exhausted CLI normally exits and
the next poll starts the prepared continuation; otherwise finish or close the
old session deliberately, then the supervisor resumes the new one.

If the exact weekly Codex signal is unavailable or malformed, it fails closed:
no automatic provider switch is made. Claude Code currently has no documented
non-interactive weekly-percent endpoint, so this release does not automatically
switch Claude back to Codex. Use the Hub toggle after a Claude limit warning;
the supervisor never scrapes a provider UI.

## Managed sessions

Start new work under the supervisor so it owns the handover boundary:

```bash
cd /home/ubuntu/jarvis
npx --no-install tsx scripts/local-handover-supervisor.ts start \
  --id my-work --cwd /home/ubuntu/my-project --task "Describe the task" \
  --checkpoint .jarvis-handover/checkpoint.md
```

The command creates a named tmux session. Attach over SSH with:

```bash
tmux attach -t jarvis-handover-my-work-r<revision>
```

When the Project Hub toggle changes provider, the supervisor writes a
mode-0600, local-only bundle with the registered task, initial user prompt,
latest submitted user instruction, Git head/status/diff stat, optional
checkpoint, and a bounded redacted terminal tail. It starts the new native
Codex or Claude tmux session with that bundle only after the old managed tmux
session exits. The old session is never killed automatically, so there is no
unsafe concurrent editing or silent loss of the last terminal state.

### Prompt continuation

For a session that the supervisor starts, prompt capture is deliberate and
provider-specific:

- Codex is bound to the exact launched thread through a non-secret correlation
  marker. The supervisor reads only canonical `userMessage` items through the
  local Codex app-server `thread/read` API; it never selects the "latest"
  account chat or parses raw rollout files.
- Claude is started with a supervisor-generated `--session-id` and a
  session-specific `UserPromptSubmit` hook. The hook records only the bounded,
  redacted submitted text for that exact session in the local state directory.

When a source session is awaiting closure, the supervisor refreshes this prompt
context again immediately before it starts the replacement. A final instruction
typed after the toggle but before the old tmux session closes is therefore
included in the target's handover bundle. Prompt text, transcripts, and
credentials never reach the Project Hub, runner endpoint, heartbeat, Convex,
or command-line arguments for the target session.

The **Initial user prompt** and **Latest user instruction** sections are
verified local captures from the bound session; the latest instruction
supersedes the initial one when they conflict. Git state, checkpoint paths, and
the terminal tail remain context to verify, not instructions to execute
blindly.

The root-owned supervisor starts Claude with project/local settings and
Claude's supported `auto` permission mode. This avoids a user-level
`bypassPermissions` default, which Claude deliberately refuses under root,
while retaining the normal authenticated Claude session.

You can register an existing tmux workflow explicitly:

```bash
npx --no-install tsx scripts/local-handover-supervisor.ts adopt \
  --id existing-work --cwd /home/ubuntu/my-project --task "Describe the task" \
  --provider codex --tmux-session my-existing-session \
  --codex-thread-id <the-exact-codex-thread-uuid>
```

An arbitrary existing Codex/Claude terminal cannot be safely converted without
an explicit adoption: it has no supervisor registry, portable checkpoint, or
controlled PTY. The supervisor intentionally leaves all unregistered processes
untouched.

For a legacy Codex session, `--codex-thread-id` is optional but enables the
same exact-thread initial/latest-prompt import. An adopted session without that
verified binding still hands over its registered task, checkpoint, Git state,
and terminal tail; it does not guess from another chat in the same directory.
An already-running Claude session cannot be retrospectively bound without a
preinstalled session hook, so it uses the same safe fallback. All new
supervisor-started Claude sessions are bound automatically.

## Service pairing

The systemd unit reads only this root-owned, mode-0600 file:

```ini
JARVIS_HANDOVER_CONTROL_URL=https://jarvis-orcin-six.vercel.app/api/local-handover/runner
JARVIS_LOCAL_HANDOVER_RUNNER_TOKEN=<paired runner token>
```

The pairing token authorizes only reading the handover policy, posting a compact
heartbeat, and the fixed Codex-weekly-threshold → Claude policy change. It is
not a Jarvis worker token, an owner session, a provider login, or a credential
for work/files/actions.

The checked-in systemd unit runs as `root`, matching the current VPS Codex and
Claude logins. Managed or adopted sessions must be owned by that same Linux
user. A separate account needs its own paired unit and registry; it cannot be
safely controlled by this root-owned runner.

## Jarvis scope

Jarvis's current deployed foreground and Trigger runtime is Codex-only. Its
existing checkpoint/requeue protocol is safe for a future dedicated local
runner, but it cannot turn a native Codex session into a Claude session. The
VPS supervisor therefore handles registered local coding sessions today; a
separate Claude runtime/authority adapter is required before it can switch an
active Jarvis Trigger job.
