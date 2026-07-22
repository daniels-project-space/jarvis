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
   The R2 client itself uses a six-hour, prefix-scoped Cloudflare temporary
   credential. A process-local single-flight replaces the client five minutes
   early (or once after a 401/403), so a cached controller never outlives its
   S3 session token.
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
6. A four-hour foreground owner renews before the snapshot's remaining window
   can no longer cover both candidate startup and one full admitted turn. It
   preflights and initializes one single-flight candidate while the current
   app-server keeps serving, publishes the candidate only between turns, then
   retires the old process. A pre-`turn/start` 401 may replay once; an accepted
   turn is never interrupted or replayed. Retired and final consumer homes are
   removed through an exact process-owned path registry after `auth.json` is
   unlinked.

## Provider handoff

The delivery controller owns configuration and deployment. It must provision a
private, non-public R2 bucket and a parent token permitted to derive scoped R2
temporary credentials, then place these values in the controller vault service
named `codex-session`:

- `R2_ACCOUNT_ID`
- `R2_PARENT_API_TOKEN`
- `R2_PARENT_ACCESS_KEY_ID`
- `R2_ENDPOINT` (the authenticated S3 endpoint, never an `r2.dev` URL)
- `R2_BUCKET` (must not be the public `jarvis` artifacts bucket)
- `SESSION_ENCRYPTION_KEY_B64` (canonical base64 for exactly 32 random bytes)
- `CODEX_AUTH_JSON_B64` (canonical bootstrap only; remove the old Trigger env
  copy)

Set `JARVIS_CODEX_SESSION_SOURCE=vault-broker` on the Trigger deployment. Only
that selector and `VAULT_ACCESS_TOKEN` are synchronized to Trigger hosts; both
are withheld from Codex and unrelated Git children. Static `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `R2_SESSION_TOKEN` values are rejected by the
session controller. Session objects are never written to Convex, Trigger
metadata, checkpoints, application APIs, Git, or the public artifacts bucket.

The closed failure signal is:

`JARVIS_CODEX_SESSION_UNAVAILABLE[<code>]: re-enrol the controller-managed ChatGPT session; do not add an API key`

Background dispatch defers on that signal. A foreground process that already
loaded a valid access snapshot continues independently; no global Codex-home
mutex is held for the duration of a conversation or job.

Cloudflare broker/store failures use separate bounded signals:

- `JARVIS_CODEX_SESSION_UNAVAILABLE[credential_broker_unavailable]`
- `JARVIS_CODEX_SESSION_UNAVAILABLE[session_store_unavailable]`

Source: [Codex authentication](https://learn.chatgpt.com/docs/auth) and
[advanced CI/CD managed auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
plus [Cloudflare R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).
