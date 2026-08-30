# Self-hosted foreground replies

This runner moves Jarvis's conversational Codex process off Trigger while
retaining the existing durable Convex queue, token-fenced claims, streaming,
attachments, cancellation, memory extraction, and tool bridge. It is an
outbound-only process: it opens no public port and needs no tunnel.

This is distinct from `docs/self-hosted-runner.md`, which describes isolated
repository workspaces for long-running background agents.

## Safety properties

- The web app selects this path only when `JARVIS_SELF_HOSTED_FOREGROUND=live`.
- Selection is fail-closed. A fresh Convex lease whose ID begins with
  `selfhost:` is required before `/api/chat`, `/api/chat/warm`, or recovery can
  admit work. A Trigger runner cannot impersonate that lease.
- The app never falls back to paid Trigger compute while self-host mode is
  selected.
- The daemon has no model API key. Codex runs only with the existing
  Vault-brokered ChatGPT subscription session.
- The state directory is explicit, outside the checkout, and rejected if it is
  the filesystem root, checkout, or `/tmp/work`.
- SIGINT/SIGTERM abort the active lease and turn. Convex keeps any uncompleted
  turn durable for the next daemon cycle.

## Host configuration

Use an always-on Daniel-controlled machine or a suitable free VM. Install the
exact repository revision and Node dependencies under a dedicated unprivileged
OS account. Do not grant the account unrelated home-directory or repository
write access.

Set these variables in the host's secret manager or service definition:

```text
JARVIS_SELF_HOSTED_FOREGROUND=live
JARVIS_SELF_HOSTED_FOREGROUND_INSTANCE=daniel-studio
JARVIS_SELF_HOSTED_FOREGROUND_STATE_DIR=/var/lib/jarvis-foreground
JARVIS_CODEX_SESSION_SOURCE=vault-broker
JARVIS_WORKER_TOKEN=<existing worker capability>
JARVIS_DISPATCH_TOKEN=<existing foreground tool capability>
VAULT_ACCESS_TOKEN=<Jarvis Vault client capability>
CONVEX_URL=https://<production-deployment>.convex.cloud
```

The three capabilities must each be at least 32 characters. Never place them
in the repository, command history, logs, or a browser environment.

Start the daemon with:

```bash
npm run foreground:selfhost
```

The process manager should use `Restart=always`, a short restart delay, and a
dedicated writable state directory. It does not need an inbound firewall rule.

## Cutover

1. Deploy the same reviewed source revision to the private host and the app.
2. Start the daemon while Vercel still lacks the self-host opt-in.
3. Query `chatQueue:runnerLease` through the owner boundary and require a fresh
   ID shaped like `selfhost:<instance>:primary:<uuid>`.
4. Add `JARVIS_SELF_HOSTED_FOREGROUND=live` to the Vercel production snapshot
   and deploy only the app. Keep the existing Trigger billing hold unchanged.
5. Submit a harmless owner text turn. Verify progressive output, completion,
   cancellation, one attachment turn, one tool call, and durable memory capture.
6. Stop the daemon and verify new turns fail visibly with
   `SELF_HOSTED_FOREGROUND_OFFLINE` before durable admission. Restart it and
   verify recovery without a Trigger run.

Do not enable the Vercel selector until the lease and the failure drill both
pass. If the private host is not yet available, the code remains inert.

## Rollback

Remove `JARVIS_SELF_HOSTED_FOREGROUND` from Vercel and redeploy the app. With
the Trigger billing hold still present, foreground admission remains visibly
paused rather than spending money. Re-enable Trigger only through the separate
billing/provider release process.
