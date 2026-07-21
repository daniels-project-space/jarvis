# Control-plane projection rollout

This change is deliberately two-phase so existing Convex `jobRuntime` rows
remain valid while the compact control-plane projection is introduced.

1. Deploy the optional-first schema. `progressAt`, `stallCount`,
   `steerRevision`, and `active` remain optional on existing rows. Trigger's
   bounded `jobs:migrateControlPlane` cursor projects at most one small page
   per invocation and records its durable cursor in `controlPlaneMigrations`.
   `executionLease` and progress updates bootstrap one missing legacy runtime
   row only until that cursor is complete.
2. Observe the migration row until both `jobsComplete` and `missionsComplete`
   are true and no legacy fallback is used. Only in a later, independently
   verified schema release may the optional fields become required.

The live work strip reads one `by_active_priority` projection index. New and
migrated rows write `active`; no seven-status subscription fan-out is used.
Heartbeats update only the compact runtime row at a minimum 60-second cadence;
they never count as evidence or refresh attempt progress.
