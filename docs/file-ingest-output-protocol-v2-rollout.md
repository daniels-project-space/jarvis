# File-ingest derived-output protocol V2 rollout

V2 gives every ingest claim a durable, attempt-scoped output namespace before
the worker can write R2. It is deliberately additive: the historical
`fileIngestCleanupOutbox` remains readable and drainable for V1 work, while
new rows live in `fileIngestOutputAttempts`.

## Release order

1. First deploy the Vercel reader compatibility **with**
   `JARVIS_FILE_INGEST_WAKE_PAUSED=1`. It accepts `.../vN/a<attempt>/...`
   keys, while continuing to accept uploads but intentionally not waking the
   file-ingest task. Set the same gate on the forthcoming V2 Trigger
   deployment so its reconciliation task also honors the bridge. This is the
   Vercel bridge: no newly uploaded file can enter an old V1 worker during the
   cutover. The gate also temporarily returns retryable `503` responses from
   file delete and upload-cancel routes, so no old direct file-cleanup task is
   enqueued while the output protocol is changing.
2. Before deploying the Convex compatibility code, pause/disable the old
   `jarvis-file-ingest` Trigger task **and every producer that can enqueue
   it** (including the old insight-engine schedule), cancel any queued old
   runs. Do the same for `jarvis-file-cleanup` and its
   `jarvis-private-file-cleanup` queue, since the historical cleanup worker
   directly deletes Convex-returned private R2 keys. Verify that the old
   deployment has no queued or running runs in either queue, and let in-flight
   Vercel upload, delete, and cancel requests finish against the bridge. Do
   **not** use the old task max duration as a proof that an R2 PUT cannot
   arrive; this is an
   operational admission fence that prevents an old worker from starting after
   the new Convex behavior is live.
3. Only after that V1 queue drain, deploy the additive Convex schema and
   compatibility mutations **plus** the `fileDerivedArtifactRehomes` control
   and manifest tables. This adds optional file fields and new rows without
   rewriting historical V1 cleanup rows. Set the dedicated
   `JARVIS_FILE_REHOME_TOKEN` in Convex and Trigger; the generic
   `JARVIS_WORKER_TOKEN` is never enough to rehome or activate output paths.
4. Deploy the rehome Trigger worker/controller and the V2 ingest Trigger
   worker while the Vercel wake gate is still paused. Vercel reader
   compatibility from step 1 is mandatory before either worker can expose a
   `.../vN/a<attempt>/...` pointer. A V2 ingest task that somehow runs before
   activation safely skips its claim; it never flips the shared protocol.
5. Start `fileDerivedArtifactRehomes:startFileDerivedArtifactRehome` with the
   dedicated rehome capability, then run
   `jarvis-file-derived-artifact-rehome-controller` until it reports ready.
   The control row first freezes normal file mutation, inventories each
   terminal V1 pointer, and locks every pointer-bearing file. Each worker
   full-GETs and SHA-256 hashes the V1 source, prewrites a fresh V2 receipt,
   PUTs a unique V2 target with digest metadata, HEADs and full-GETs the
   target, and atomically CAS-repoints the file only after the byte-for-byte
   proof succeeds. It never deletes a V1 source inline; a permanent V1 source
   sweeper starts only after the pointer CAS. A missing role, non-identical
   readback, or CAS conflict leaves a durable blocked record and prevents
   activation. Before inventory, the controller also pages every durable V1
   cleanup bridge. A bridge records its exact text/preview delete subset; if
   that subset still intersects a live terminal V1 pointer, rehome blocks
   rather than pretending that an expired lease or completed queue run is a
   storage-provider fence. The capability-only
   `acknowledgeFileDerivedArtifactRehomeCleanupHistory` transition is allowed
   only after an operator establishes the provider-side fence and
   checks/restores the canonical source. It acknowledges one exact bridge,
   restarts the full preflight, and still requires the ordinary
   full-readback/CAS/audit proof; it is not an activation override.
6. Invoke the release-only Trigger task
   `jarvis-file-ingest-output-protocol-v2-activate` with only
   `{ triggerDeploymentVersion: "<V2 release>" }`. It has no
   `legacyTriggerDrained` input. Convex server-state asserts the sealed
   inventory, zero blocked/pending manifests, and zero terminal V1 pointers
   before atomically recording activation and requeueing pending uploads with
   a fresh activation-timestamp namespace. If it reports 64 requeues, wait
   for those claims to start and invoke it again until the batch is below 64.
   The two-hour reconciliation sweep is only a fallback, not activation.
7. Confirm the activation task's requeue completed, then deploy Vercel again
   with `JARVIS_FILE_INGEST_WAKE_PAUSED` unset (or not `"1"`). New uploads now
   schedule the V2 Trigger normally.
8. Keep the V1 bridge sweep active until the old Trigger deployment is
   demonstrably retired. A stale V1 claim is rotated to a fresh V2 ingest
   version before a V2 attempt is allocated, so a late V1 worker can never
   overwrite V2 pointers. The drain duration is operational guidance, not a
   proof that an accepted R2 write cannot arrive late.

## Cleanup contract

- A successful `completeIngest` consumes its exact V2 attempt atomically with
  the durable file pointers.
- Before either derived R2 PUT, the V2 worker records a durable prewrite
  marker for its exact attempt. A worker that reaches a terminal failure or
  response-loss retirement hands that attempt to cleanup, but cleanup may
  consume it only when no derived write was ever started.
- An expired worker lease is not a terminal handoff, and neither is a client
  error after a prewrite marker. Such a V2 row remains in `sweeping` and
  repeatedly deletes only that attempt's two deterministic paths. This
  preserves a reaper for an R2 PUT that completed after the first cleanup
  pass.
- Cleanup callers never supply object keys. Convex reconstructs and validates
  both keys from the file ID, ingest version, protocol, and attempt ID.

No V2 pointer-producing Trigger activation should precede both the Convex
compatibility deployment and the Vercel/private-R2 reader compatibility deploy.
More importantly, no Convex compatibility deployment should begin while an
old V1 worker can still be queued or started: the Vercel wake gate and old
Trigger queue drain must happen first.

## Hard V1 residual-operation no-go

The historical V1 Trigger can receive a successful `completeIngest` mutation,
lose its response, and then issue its own inline R2 DELETE for the now
committed V1 pointer. Pausing queues and waiting for task completion does not
prove that a provider-accepted DELETE cannot complete later. The V1 bridge
reaper deliberately handles only unreferenced shared output; using it against
a still-ready pointer would turn a recoverable race into intentional data
loss.

An integrity read can detect the missing derivative and re-ingest it from the
canonical original, but it is a repair after the fact, not a fence against the
next late DELETE. Therefore **do not activate V2 in production merely after a
finite V1 drain**. Activation is a release no-go until one of these is true:

- the storage provider offers a durable fence/cancellation guarantee for every
  pre-cutover V1 DELETE; or
- a separate migration has re-ingested every ready V1 derived output into a
  V2 attempt-scoped path, atomically repointed the file row, and read back the
  new pointer before activation.

The durable rehome protocol now supplies the second condition for every
pointer-bearing terminal V1 row. It does not turn a finite drain into a
provider fence: source-missing, non-identical, or conflicting rows remain
blocked and are an explicit production no-go until repaired and re-verified.

The historical one-shot cleanup worker predates durable per-delete ownership.
For a row that has already disappeared from its old outbox, software cannot
retroactively prove whether an R2 DELETE was accepted and is still in flight.
The new bridge/preflight records every **future** cleanup handoff, but it does
not manufacture proof for that historical gap. Do not treat a missing marker,
a timeout, a queue drain, or the acknowledgement mutation as that proof. If a
source is missing or suspect, rehome from the canonical original and verify
the new target before attempting activation; otherwise leave the rollout
blocked.
