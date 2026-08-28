# Private creation-asset rollout

This change is a cross-provider protocol release. A provider order by itself is
not safe: an older Vercel or Trigger worker can still perform an unconditional
R2 operation after Convex has started enforcing the new creation fence. The
release owner must record the candidate Git SHA and the matching Vercel,
Trigger, and Convex deployment IDs in the change record.

## Compatibility bridge

Ship the candidate Vercel build before Convex. Its artifact producers call
`creationAssetCleanup:reserve` before any R2 PUT, so against the old Convex
deployment they fail before writing. Its private-creation delete route first
requires `creationAssetCleanup:protocol`; that function is absent on old
Convex, so it rejects before removing metadata. The temporary user-visible
effect is that generating/storing/exporting a private creation and deleting a
private creation are unavailable; unrelated UI and legacy metadata-only
creation deletion continue to work.

The same reserve-first library is used by the Trigger tool producers. Deploy a
new Trigger version before the Convex cutover, but do not let old producer
runs start while it drains.

## Required release sequence

1. Record the candidate SHA. Deploy that exact Vercel build to the production
   alias and verify the alias's source SHA in Vercel. Do not treat a Git push
   as proof that the alias changed.
2. After the alias is confirmed, wait **150 seconds** before changing Convex:
   this covers the longest old HTTP creation producer (`/api/tools`,
   `/api/agent-tool`, and `/api/foreground-owner-tool`: 120 seconds) plus a
   30-second drain margin. `/api/creation-export` is limited to 30 seconds.
   The new Vercel build is fail-closed throughout this bridge.
3. In Trigger production, pause these queues before the old-version drain:

   - `{ type: "custom", name: "jarvis-background-agents" }` — owns
     `jarvis-agent-worker`.
   - `{ type: "task", name: "jarvis-agent-fleet-supervisor" }` — cron every
     five minutes and can wake the agent fleet.
   - `{ type: "task", name: "jarvis-goal-coordinator" }` — cron every
     30 minutes and can wake the agent fleet.
   - `{ type: "task", name: "jarvis-insight-engine" }` — cron every two hours
     and can wake the agent fleet.

   Use Trigger's supported `queues.pause` management operation for each. A
   dashboard-wide environment pause, if offered, is stronger, but it is not a
   substitute for recording these queue-level controls. Pausing prevents new
   runs from starting; it does not stop already executing runs. Save the
   current (old) Trigger deployment version and queue/run snapshots as the
   pre-cutover evidence.
4. Deploy the candidate Trigger task bundle with no promotion:

   ```bash
   npx --yes trigger.dev@4.5.1 deploy --skip-promotion
   ```

   Verify in the Trigger dashboard/API that this version was built from the
   candidate SHA. It is safe for this bundle to be present while Convex is
   still old because its reserve-first producers decline before R2.
5. Drain the old Trigger version before Convex changes. Cancel old-version
   `PENDING_VERSION`, `DELAYED`, `QUEUED`, and `WAITING` runs. Waiting does not
   consume execution concurrency, but it can resume old code later; canceling
   it stops the run and its children. Do **not** cancel `DEQUEUED` or
   `EXECUTING` producers as a shortcut—Trigger counts dequeued work as
   executing. Leave the queues paused and let active/dequeued old runs finish
   naturally. `jarvis-agent-worker` has the longest creator lifetime:
   **30 minutes**. Because Vercel activity can still enqueue work while that
   queue is paused, re-list and cancel old nonexecuting runs on every drain
   pass. Re-list until the old version has zero nonterminal runs, then retain
   a 2-minute observation margin. If any executing old producer cannot settle,
   keep the bridge and pause in place; do not proceed to Convex.

   The Trigger SDK/API evidence is a paginated `runs.list` filtered by the old
   deployment version and every nonterminal status (`PENDING_VERSION`,
   `DELAYED`, `QUEUED`, `DEQUEUED`, `EXECUTING`, and `WAITING`), together with
   queue statistics proving the producer queue remains paused. The supported
   management operations are `queues.pause`, `queues.resume`, `runs.list`, and
   `runs.cancel`; use the production dashboard or an approved release console
   so credentials never enter shell history.
6. Deploy Convex from the same candidate SHA:

   ```bash
   npx convex deploy
   ```

   Verify the read-only `creationAssetCleanup:protocol` query returns
   `{ cleanupProtocol: "nonterminal-reaper-v1" }` before allowing any producer
   queue to resume.
7. Promote the already-built Trigger version, verify its deployment version,
   then resume the paused environment/queues. Confirm the Vercel production
   alias still points to the same candidate SHA and that one authorized
   creation write and deletion follow the new contract.

## Rollback rule

After Convex is deployed, **never roll Vercel or Trigger back to the old
unfenced code**. It can issue direct R2 deletes that the new Convex contract
cannot fence. For an incident, keep the Vercel bridge and Trigger queues
paused, preserve the durable cleanup intents, and forward-fix or roll the
three providers back as one explicitly reviewed operation.

## Scope inventory

All private creation writers in this release are covered by the shared
reserve-first primitive:

- Vercel: `/api/creation-export` (30 seconds).
- Vercel tool routes: `/api/tools`, `/api/agent-tool`, and
  `/api/foreground-owner-tool` (120 seconds each).
- Trigger/agent tool path: `jarvis-agent-worker` (30 minutes).

The permanent reaper deliberately retains one small Convex intent per deleted
or failed private asset and schedules at most four cleanup attempts per
two-hour reconciliation window. That is an intentional provider-independent
safety tradeoff: it avoids claiming a finite R2 request deadline that the
provider does not guarantee. Monitor intent backlog and sweep latency as a
separate operational metric; do not replace this with a terminal TTL unless a
provider-enforced fence is introduced.
