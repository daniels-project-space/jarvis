/**
 * Repository-owned multiline approval reproductions. Keeping the full shape
 * and offending line positions here prevents the policy suite from depending
 * on runner-local /tmp files that are not available in every isolated worker.
 */
export const WORKSPACE_ISOLATION_APPROVAL_TASK = [
  "Repository-only implementation task for daniels-project-space/jarvis.",
  "Start from the accepted integration head and preserve its exact ancestry.",
  "Require one unique controller-assigned worker branch and workspace per writable job.",
  "Trace queue, claim, runner, review, integration, retry, and recovery callers before editing.",
  "Workers may commit only to their isolated worker branch.",
  "Workers must never deploy, merge, push, open a pull request, or mutate provider state.",
  "Bind review evidence to the exact worker head and tree before integration.",
  "Reject stale, shared, reused, or ambiguously owned writable workspaces.",
  "Keep read-only validators pinned to immutable reviewed input.",
  "Run focused race tests, the full suite, typecheck, build, audit, and secret scan.",
  "Only the trusted delivery controller may publish the reviewed Git worker ref after verification.",
  "Commit the repository-only correction and report the exact evidence to the controller.",
].join("\n");

export const INTEGRATION_FINAL_BARRIER_APPROVAL_TASK = [
  "Repository-only correction for the accepted Jarvis integration revision.",
  "Trace the durable integration attempt, provider effect ledger, and terminal job transition.",
  "Preserve the exact reviewed head, tree, generation, and integration-base fences.",
  "Do not deploy, merge, push, open a pull request, or mutate provider state from the worker.",
  "Reconcile unknown provider outcomes by observation before any retry.",
  "Keep pause, cancel, steering, retry, and lease-loss behavior fail closed.",
  "Do not mark the goal complete until every staged object and ref effect is durably observed.",
  "Retain provider response evidence and idempotency identity across controller recovery.",
  "Reconcile the already-applied stage_blob POST whose callback was lost without issuing it again.",
  "Run focused integration tests, the full suite, typecheck, build, audit, and secret scan.",
  "Commit only the isolated worker branch and leave controller delivery separate.",
].join("\n");
