# Codex subscription session controller

Jarvis uses ChatGPT-managed Codex authentication only. It has no
`OPENAI_API_KEY` or `CODEX_API_KEY` fallback.

The official Codex automation contract says that Codex refreshes file-based
managed login state in place and that automation must persist the updated file
between runs. Jarvis implements that contract as a controller boundary:

1. A Trigger host asks the session controller for a snapshot. It never reads a
   bootstrap session from its environment.
2. One strongly consistent R2 state object contains the current immutable
   snapshot pointer and the sole writer lease. Every acquire, renewal, commit,
   and recovery is an ETag compare-and-swap; each recovered writer increments
   the fence.
3. The elected writer alone materializes the real refresh token in a mode-0600
   controller directory outside repository workspaces. It runs a pinned,
   no-tools Codex parent, re-reads `auth.json` even after a child crash, seals
   the result with AES-256-GCM, writes an immutable version, and only then
   advances the state pointer.
4. Concurrent workers receive separate writable `CODEX_HOME` directories with
   the current access/identity snapshot and
   `jarvis-controller-refresh-required` in place of the refresh token. After an
   app-server loads that snapshot, the host deletes the file before model tools
   can run.
5. A 401 causes one reacquisition for a version newer than the rejected one.
   Other workers wait or continue with a still-valid snapshot; none submits the
   controller refresh token.

## Provider handoff

The delivery controller owns configuration and deployment. It must provision a
private, non-public R2 bucket and a bucket-scoped read/write token, then place
these values in the controller vault service named `codex-session`:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` (the authenticated S3 endpoint, never an `r2.dev` URL)
- `R2_BUCKET` (must not be the public `jarvis` artifacts bucket)
- `SESSION_ENCRYPTION_KEY_B64` (canonical base64 for exactly 32 random bytes)
- `CODEX_AUTH_JSON_B64` (canonical bootstrap only; remove the old Trigger env
  copy)

Only `VAULT_ACCESS_TOKEN` is synchronized to Trigger hosts. Session objects are
never written to Convex, Trigger metadata, checkpoints, application APIs, Git,
or the public artifacts bucket.

The closed failure signal is:

`JARVIS_CODEX_SESSION_UNAVAILABLE[<code>]: re-enrol the controller-managed ChatGPT session; do not add an API key`

Background dispatch defers on that signal. A foreground process that already
loaded a valid access snapshot continues independently; no global Codex-home
mutex is held for the duration of a conversation or job.

Source: [Codex authentication](https://learn.chatgpt.com/docs/auth) and
[advanced CI/CD managed auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth).
