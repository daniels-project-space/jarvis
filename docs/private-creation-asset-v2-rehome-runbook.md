# Private creation-asset V2 rehome runbook

This is a controlled, owner-only migration. It is not a deploy hook and it
does not authorize a bucket, credential, or production deployment change by
itself. The release gate in
[`private-creation-asset-rollout.md`](./private-creation-asset-rollout.md)
remains controlling; if its current **NO-GO** has not been resolved in the
change record, stop here.

## 1. Prove isolation before selecting V2

Create and record a distinct R2 bucket with this exact name:

```text
jarvis-private-creation-assets-v2
```

It must not be the existing private-file/private-creation bucket, an alias,
or an interchangeable compatibility name. In the provider console or approved
release console, retain evidence of all of the following without placing a
secret in a ticket, shell history, chat, or source tree:

- the Cloudflare account identifier and the exact V2 bucket identifier/name;
- the V2 bucket's empty-or-expected inventory before migration;
- a separate access-key identity/policy whose object permissions are limited
  to that V2 bucket; and
- evidence that the V2 key has no read, write, list, or delete permission on
  the V1/private-file buckets.

Create a separate vault service named:

```text
cloudflare-private-r2-v2
```

Only that service may contain the V2 R2 values `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, and, when used, `R2_SESSION_TOKEN`.
Do not reuse the legacy `cloudflare` service or copy its credentials. The
endpoint may identify the same Cloudflare account, but the credential scope
must be V2-bucket-only.

This repository does **not** create the required Project Hub vault endpoint.
Before V2 is selected anywhere, the Project Hub source and deployment must
provide the fixed `privateCreationAssetV2:credentials` query. It must accept
only `{ v2VaultToken }`, map that bearer to a new V2-only client identity,
hard-code `cloudflare-private-r2-v2` internally, and have this exact **query
return value**:

```json
{
  "service": "cloudflare-private-r2-v2",
  "secrets": {
    "R2_ACCESS_KEY_ID": "…",
    "R2_SECRET_ACCESS_KEY": "…",
    "R2_ENDPOINT": "…",
    "R2_SESSION_TOKEN": "…"
  }
}
```

`R2_SESSION_TOKEN` is optional; no other field may be returned. The fixed
`/api/query` HTTP transport must wrap that return value as:

```json
{
  "status": "success",
  "value": { "service": "cloudflare-private-r2-v2", "secrets": { "…": "…" } }
}
```

The outer envelope is transport-only; its `value` must obey the exact field
rule above. The endpoint must not accept a `service` argument, proxy
`secrets:listByService`, or use the legacy Jarvis `VAULT_ACCESS_TOKEN`. Until
this externally deployed endpoint is independently tested, this migration is a
**NO-GO**.

Record the provider-side cross-denial evidence before proceeding. These are
Convex `/api/query` calls: each negative probe must return its normal HTTP
`200` transport response with a parsed JSON envelope whose `status` is exactly
`"error"`, and it must expose no credentials, endpoint, bucket, service, or
credential-bearing `value`. Do not treat a transport success as authorization
success. A literal HTTP `401`/`403` is expected only if a separately reviewed
custom HTTP action is added later; it is not the current query contract.

- legacy `VAULT_ACCESS_TOKEN` calling `secrets:listByService` for
  `cloudflare-private-r2-v2` receives that fail-closed `status: "error"`
  envelope;
- that legacy token calling `privateCreationAssetV2:credentials` receives the
  same fail-closed envelope;
- the V2-only bearer calling generic `secrets:listByService` for any service
  receives the same fail-closed envelope; and
- the V2-only bearer can call only the fixed endpoint and receive only the
  fixed V2 service/fields above.

If the legacy bearer is wildcard-scoped or can list the V2 service, the same
Project Hub deployment/origin is not an isolation boundary: stop and use a
separate V2 vault deployment/origin. Also retain evidence that V2 R2
credentials cannot read, write, list, or delete V1/private-file buckets, and
that V1 credentials cannot access the V2 bucket.

## 2. Provision both runtimes independently

Set these non-secret production environment values in **Vercel** for the
exact production project/release:

```text
JARVIS_PRIVATE_CREATION_ASSET_STORE=private-r2-v2
JARVIS_PRIVATE_R2_V2_BUCKET=jarvis-private-creation-assets-v2
JARVIS_PRIVATE_R2_V2_ENDPOINT=https://<32-hex-account-id>.r2.cloudflarestorage.com
```

Set the separate secret `JARVIS_PRIVATE_CREATION_ASSET_V2_VAULT_TOKEN` only in
this new V2-capable Vercel deployment. The client uses the fixed Project Hub
`privateCreationAssetV2:credentials` endpoint and has no `VAULT_ACCESS_TOKEN`
or generic-vault fallback. Do not put the four R2 credential values in Vercel
environment variables.

Set the same non-secret selector/bucket/endpoint values plus the separate V2
token for the **Trigger** V2 migration runtime. `syncEnvVars` is global to a
Trigger build; it is not task-scoped isolation. Use a dedicated V2 Trigger
project/environment or a provider-supported task-scoped secret for
`creation-asset-rehome` and `creation-asset-rehome-capability`, and record
evidence that every legacy Trigger deployment/environment lacks the V2 token.
A source declaration is not proof that a deployed runtime received (or did not
receive) a value. Record the Vercel release ID, dedicated Trigger deployment
version/project, and their environment evidence.

Selecting V2 for a runtime is a deliberate pause for that runtime's **normal
private-creation producers** until durable activation. The isolated proof may
write only its probe namespace, but ordinary V2 reservation and creation
metadata are rejected before `state: "activated"`. Keep V2-selected normal
producers paused (and do not build an automatic retry loop around those
rejections) throughout preflight, freeze, copy, and cutover. A separately
V1-selected compatible producer remains usable only until the durable freeze
begins.

No V1-to-V2 fallback is valid. A missing selector, a mismatched bucket name,
an unavailable V2 vault service, or credentials without V2 access is a stop;
correct that runtime and begin a new preflight attempt.

## 3. Run the two-runtime preflight

With the rollout gate satisfied and the owner session active, invoke:

```text
POST /api/admin/creation-asset-rehome
```

The first call is expected to return `202` while preflight is pending. It
performs a Vercel-runtime V2 probe and dispatches an opaque proof ID to
`jarvis-creation-asset-rehome-capability`. Trigger then independently performs
its own V2 `PUT`, full-body `GET`/SHA-256 readback, and probe `DELETE` using
its deployed selector and vault capability. The task never receives a source
key, destination key, bucket name, or vault selector.

Repeat the owner action only to observe/advance the durable preflight. Do not
manually mark it successful. The Convex V1 path remains unfrozen until both
persisted proof records are current and verified, but a normal producer that
has already selected V2 remains paused/rejected until activation. A failed or
expired proof creates a fresh audited preflight attempt; it must never be
treated as a V1 fallback.

## 4. Controlled migration and activation

Once both proofs are verified, the same owner action may insert the durable
freeze/snapshot state. It copies only the immutable V1 manifest, verifies every
destination with a full-byte SHA-256 readback, and CAS-checks the V1 metadata
at cutover. The destination grammars are intentionally disjoint:

```text
V2 live:      owners/daniel/creation-assets-v2/live/<uuid>/(asset|thumb)
V2 migration: owners/daniel/creation-assets-v2/migration/<attempt>/<opaque-creation-id>/generation/<copy-generation>/(asset|thumb)
V2 probe:     owners/daniel/creation-assets-v2/probe/<opaque-proof-id>/capability
```

All three are legal only in the V2 bucket. A restarted migration receives a
new `<attempt>` namespace, and **every** copy claim/retry receives a new
immutable `<copy-generation>` target. A worker whose lease expired may still
finish an already-authorized R2 PUT, but it can land only in its old generation;
cutover swaps metadata only to the exact generation whose ticket completed
full-byte SHA-256 readback. The task gets only a creation ID; Convex issues the
short-lived copy/deletion tickets and supplies immutable locators only after
claiming them.

Treat the migration as active only when the control response and durable status
both show:

```text
state: "activated"
active: "private-r2-v2"
expectedCount === verifiedCount === cutoverCount
```

`activate` writes that persisted state; it is not an assertion. V2 upload
reservation and creation metadata remain rejected before it exists. Do not
delete V1 source objects after activation: their manifest entries remain audit
evidence and no V1-source deletion path is part of this rehome.

## 5. Pre-cutover recovery only

If migration is pending/failed and `cutoverCount` is exactly zero, first return
both Vercel and Trigger selectors to `private-r2-v1` in reviewed releases so
new producers use V1 again. Then the owner may call:

```json
{ "action": "abort", "reason": "brief operational reason" }
```

against the same control endpoint. The durable `aborted` state reopens V1 but
continues to reject V2. After correcting V2 isolation/configuration, re-run the
two-runtime preflight and start a fresh snapshot attempt.

Never use abort after any cutover row exists. The service rejects it once
`cutoverCount > 0`, while cutting over, after cutover, or after activation;
keep that state fail-closed and use a separately reviewed repair plan instead.
