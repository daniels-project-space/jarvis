# Self-hosted background workspace runner

Jarvis can use a Daniel-controlled machine for the repository workspace part
of long-running work. This avoids Vercel Sandbox compute. It does **not** add
a second job queue: Convex remains the durable authority for jobs, leases,
checkpoints, cancellation, and recovery; Trigger continues to run the
subscription-authenticated Codex controller; the runner receives only a
credentialless git archive and bounded repository-tool calls.

The route is disabled by default. Selecting `selfhost` without every item
below blocks before source hydration, workspace creation, or Codex execution.

## Recommended free deployment

Run one runner on Daniel's own always-on Mac, Linux box, or free-tier VM. Put
it behind an HTTPS reverse tunnel such as Cloudflare Tunnel. Do not expose the
runner's container daemon, SSH, Docker socket, or workspace filesystem to the
internet. The public tunnel may reach only the runner API, protected by its
own bearer. Do not use the retired Jarvis VPS as this runner.

The host must create a fresh rootless container or VM per workspace, cap it at
2 vCPU / 4096 MiB / 55 minutes or lower, disable all egress by default, and
delete it on every terminal/orphan/cancelled call. It must start with an empty
environment (apart from non-authority runtime variables); it must never mount
the host home directory, Docker socket, cloud credentials, Codex state,
GitHub token, Convex/Trigger/Vault credentials, or an SSH agent.

`repository_exec` is intentional: it runs only inside that disposable
workspace and is exposed to Codex through the existing immutable work-order
scope. The runner must execute it with a process group/cgroup so disconnect or
cancel kills every descendant, not just a shell wrapper.

## Configuration

Store these values only in the Jarvis Vercel/Trigger server environment (or
the Project Hub vault materialized there). They must never be `NEXT_PUBLIC_*`
values and must not be put in a repository, browser, sandbox, job payload, or
Codex child environment.

```text
JARVIS_CLOUD_WORKSPACE_PROVIDER=selfhost
JARVIS_SELF_HOST_RUNNER_URL=https://runner.example.com/jarvis
JARVIS_SELF_HOST_RUNNER_TOKEN=<random 32+ character base64url secret>
JARVIS_CLOUD_WORKSPACE_TEMPLATE=<immutable runner image identity>
JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST=<sha256 of the immutable image policy>
JARVIS_CLOUD_PROVIDER_PROBE=live
JARVIS_CLOUD_PROVIDER_PROBE_KEYRING=<existing controller-only keyring>
```

The URL must be an HTTPS URL without query parameters, fragments, or embedded
credentials. Both the URL and bearer must be present. The adapter sends the
bearer only in `Authorization: Bearer …`, refuses redirects, and refuses a
runner response that changes the workspace/session identity.

The existing `jarvis` vault service must also retain its
`CLOUD_PROVIDER_PROBE_BOOTSTRAP_CAPABILITY`; it authorizes the existing
owner-only verification task and is never copied into the runner or browser.

After the host is up and the variables are deployed to Trigger, use Jarvis’s
existing owner-only **Verify release** control. The probe creates a real
workspace, checks the runner's policy claim, uploads a credentialless archive,
checks empty environment / resource bounds / denied egress, proves exact
cancellation, creates and replays a portable checkpoint, and terminates both
workspaces. Only then does it write the deployment-bound signed receipt that
Goal Mode requires. It is safe to leave `JARVIS_CLOUD_PROVIDER_PROBE` unset
until the host is ready.

## Runner API v1

The Trigger adapter implements `jarvis-self-hosted-runner-api` **1.0.0**.
Every request includes both:

```text
Authorization: Bearer <JARVIS_SELF_HOST_RUNNER_TOKEN>
X-Jarvis-Self-Hosted-Runner-Protocol: 1.0.0
```

All workspace-specific endpoints must also bind the exact session identity.
The runner must reject unknown fields, a mismatched workspace/session pair,
expired workspaces, absolute/parent-traversal file paths, symlinks, redirect
responses, oversized payloads, and attempts to increase controller limits.
Responses must never echo the bearer or host secrets.

| Method | Route | Required behavior |
| --- | --- | --- |
| `POST` | `/v1/workspaces` | Accept `{attemptKey, template, runtime, lockfileDigest, limits}`. Create/reconcile that exact attempt and return `{workspaceId, sessionId, root:"/workspace/repository", createdAt}`. |
| `PUT` | `/v1/workspaces/:workspaceId/files` | Require `X-Jarvis-Workspace-Session`, `X-Jarvis-Workspace-Path`, and `X-Jarvis-Max-Bytes`; write the binary body only inside the disposable workspace/control directory. |
| `GET` | `/v1/workspaces/:workspaceId/files?path=<absolute-fenced-path>&max=<n>` | Require the session header. `Accept: application/octet-stream` returns a binary file; `Accept: application/json` returns `{entries:[relativePath]}` for a bounded directory listing. |
| `POST` | `/v1/workspaces/:workspaceId/exec` | Require `{sessionId, command, cwd:"/workspace/repository", timeoutMs, maxOutputBytes}`. Run in the exact workspace with empty env and no egress. On HTTP disconnect/abort, kill the command process group and descendants. Return `{exitCode, stdout, stderr, sessionId, durationMs}` only after a terminal state. |
| `GET` | `/v1/workspaces/:workspaceId/attestation` | Require the session header. Return the exact protocol/workspace/session/state plus bounded `limits`, finite `quota`, and `security` booleans shown below. |
| `DELETE` | `/v1/workspaces/:workspaceId` | Require `{sessionId, reason}` and delete the exact workspace/process group. It must be idempotent after a confirmed deletion. |

The `attestation` response has this required shape (additional secrets or host
metadata are forbidden):

```json
{
  "protocolVersion": "1.0.0",
  "workspaceId": "...",
  "sessionId": "...",
  "state": "running",
  "limits": { "cpu": 2, "memoryMb": 4096, "ttlMs": 3300000 },
  "quota": { "maxActiveWorkspaces": 1, "activeWorkspaces": 1 },
  "security": {
    "credentiallessArchive": true,
    "privateIngress": true,
    "networkDenyByDefault": true,
    "emptyEnvironment": true,
    "boundedResources": true,
    "boundedTtl": true,
    "exactCommandCancellation": true,
    "portableCheckpointReplay": true
  }
}
```

The policy claim alone is not sufficient for admission. Jarvis verifies it and
then performs the behavioral lifecycle proof against the same workspace.

## What survives a failure

The runner is disposable compute. Existing `jobs:checkpointAndRequeue` and
the R2 content-addressed checkpoint store remain the recovery authority. A
checkpoint contains the credentialless source and validated patch, tied to the
job, attempt, source archive digest, template, and runner identities. A later
attempt creates a new workspace and reconstructs from that portable checkpoint;
it never relies on a host volume or a hidden persistent session.

No model-routing setting changes for this provider. Normal background work
continues to use Terra with `xhigh` or `ultra` reasoning as selected by the
existing policy. Sol with `max` remains reserved for explicit or critical
exceptional work.
