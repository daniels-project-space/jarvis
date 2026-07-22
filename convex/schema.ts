import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// JARVIS memory index. Full markdown bodies live in R2 (bucket `jarvis`);
// Convex holds the reactive index for search/recall. Multi-stage consolidation
// (daily -> weekly -> long-term) is driven by Trigger.dev tasks.
export default defineSchema({
  memory: defineTable({
    kind: v.string(), // "daily" | "knowledge" | "weekly" | "fact" | "project"
    title: v.string(),
    body: v.string(), // short/distilled body; full text in R2 via r2Key
    tags: v.array(v.string()),
    r2Key: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_kind", ["kind"])
    .index("by_createdAt", ["createdAt"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] }),

  // Storage-only archive from the pre-streaming chat transport (6 rows on the
  // canonical deployment at retirement). No runtime function reads/writes it;
  // chatMessages is the sole conversation source. Keep the archive until
  // Daniel explicitly authorises historical data deletion.
  chat: defineTable({
    threadId: v.string(),
    role: v.string(), // "user" | "assistant"
    content: v.string(),
    createdAt: v.number(),
  }).index("by_thread", ["threadId", "createdAt"]),

  // Queue transport for the subscription brain: UI writes a pending user row;
  // the Trigger dispatcher claims it, opens a streaming assistant row, streams
  // Codex subscription deltas in, and finalizes. UI subscribes reactively.
  chatMessages: defineTable({
    threadId: v.string(),
    role: v.string(), // "user" | "assistant"
    text: v.string(),
    status: v.string(), // "pending" | "streaming" | "done" | "error"
    model: v.optional(v.string()), // Codex model/tier that answered (Luna|Terra|Sol|live)
    // One durable turn identity crosses browser -> Vercel -> Convex -> Trigger.
    // requestId makes client retries idempotent; parentMessageId prevents a
    // concurrent/late assistant row from being mistaken for another turn.
    requestId: v.optional(v.string()),
    parentMessageId: v.optional(v.id("chatMessages")),
    // Background work may inform Daniel, but it is never a foreground answer
    // and therefore never owns captions, narration, or microphone turn-taking.
    delivery: v.optional(v.union(v.literal("foreground"), v.literal("notification"))),
    // Streaming text is an idempotent snapshot, not an append-only byte pipe.
    // Convex rejects old revisions and all writes after finalization.
    streamRevision: v.optional(v.number()),
    // Persistent media card: everything JARVIS shows also lands in the stream
    // so Daniel can always get back to it later.
    attachment: v.optional(
      v.object({ type: v.string(), value: v.string(), title: v.optional(v.string()) }),
    ),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_request", ["requestId"]),

  chatSessions: defineTable({
    threadId: v.string(),
    status: v.string(), // "idle" | "working"
    // Storage-only compatibility for sessions written before the Codex cutover.
    // Active workers no longer read or write this value.
    claudeSessionId: v.optional(v.string()),
    lastActiveAt: v.number(),
  }).index("by_thread", ["threadId"]),

  // Snapshot of project / cloud-stack state so JARVIS can answer "state of my apps".
  projectState: defineTable({
    slug: v.string(),
    status: v.string(),
    summary: v.string(),
    data: v.optional(v.any()),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  // Durable outcomes, not ephemeral task lists. Project state tells Jarvis
  // what is deployed; goals tell it why the app exists and what progress
  // should be judged against across conversations and agent missions.
  projectGoals: defineTable({
    fingerprint: v.string(),
    project: v.string(),
    title: v.string(),
    outcome: v.string(),
    status: v.string(), // proposed | active | blocked | achieved | dropped
    priority: v.number(),
    progress: v.number(),
    nextAction: v.optional(v.string()),
    blockedBy: v.optional(v.string()),
    evidence: v.array(v.string()),
    owner: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_fingerprint", ["fingerprint"])
    .index("by_project_status", ["project", "status"])
    .index("by_status_priority", ["status", "priority"])
    .index("by_updatedAt", ["updatedAt"]),

  // Background agent jobs: the brain enqueues, Trigger executes the routed
  // subscription agent in bounded segments, and JARVIS reviews the evidence.
  // Storage-only archive from the retired unleased watch implementation. All
  // rows were inactive at retirement; watchRules is the sole live system.
  watches: defineTable({
    query: v.string(),
    targetGbp: v.optional(v.number()),
    lastGbp: v.optional(v.number()),
    status: v.string(), // active | cancelled
    checkedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  // Canonical deterministic product hunts and asset thresholds. Due work is
  // indexed and leased; observations carry provider/freshness provenance.
  watchRules: defineTable({
    kind: v.string(), // product | asset
    subjectKey: v.string(),
    label: v.string(),
    status: v.string(), // active | paused | completed | cancelled
    definition: v.any(),
    cadenceMs: v.number(),
    nextCheckAt: v.number(),
    version: v.number(),
    triggerSeq: v.number(),
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    lastObservation: v.optional(v.any()),
    conditionMet: v.optional(v.boolean()),
    lastTriggeredAt: v.optional(v.number()),
    cooldownUntil: v.optional(v.number()),
    lastNotifiedValue: v.optional(v.number()),
    failureCount: v.number(),
    lastError: v.optional(v.string()),
    originThreadId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_nextCheckAt", ["status", "nextCheckAt"])
    .index("by_subject_status", ["subjectKey", "status"])
    .index("by_updatedAt", ["updatedAt"]),

  watchEvents: defineTable({
    eventKey: v.string(),
    watchId: v.id("watchRules"),
    ruleVersion: v.number(),
    kind: v.string(),
    reason: v.string(),
    previousValue: v.optional(v.number()),
    observation: v.any(),
    title: v.string(),
    spoken: v.string(),
    detail: v.string(),
    status: v.string(), // open | seen | dismissed
    glowUntil: v.number(),
    chatMessageId: v.optional(v.id("chatMessages")),
    pushStatus: v.string(), // pending | sent | failed
    pushAttemptedAt: v.optional(v.number()),
    pushSentAt: v.optional(v.number()),
    createdAt: v.number(),
    seenAt: v.optional(v.number()),
  })
    .index("by_eventKey", ["eventKey"])
    .index("by_watch_createdAt", ["watchId", "createdAt"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  // Timed reminders — delivered by the agent-runner cron as push + weave.
  reminders: defineTable({
    text: v.string(),
    at: v.number(), // epoch ms when it should fire
    status: v.string(), // pending | delivering | done | cancelled
    originThreadId: v.optional(v.string()),
    deliverStartedAt: v.optional(v.number()),
    deliveryAttempts: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_status", ["status", "at"]),

  jobs: defineTable({
    repo: v.optional(v.string()),
    task: v.string(),
    status: v.string(), // pending | dispatching | running | done | error
    result: v.optional(v.string()),
    readonly: v.optional(v.boolean()), // if true, runner never commits/pushes
    model: v.optional(v.string()), // optional Codex tier override (luna|terra|sol)
    reasoningEffort: v.optional(v.string()), // optional per-job override (low|medium|high|max)
    mcp: v.optional(v.array(v.string())), // MCP servers to attach (playwright, context7)
    incidentId: v.optional(v.string()), // set on self-repair jobs → resolves the incident on success
    retried: v.optional(v.boolean()), // failed once already — no second retry
    missionId: v.optional(v.string()), // part of an orchestrated fleet
    label: v.optional(v.string()), // short fleet-view label ("pricing research")
    progress: v.optional(v.string()), // live activity line the runner streams
    log: v.optional(v.string()), // rolling CLI session transcript tail (pill live view)
    // Durable work-control metadata. Trigger executes bounded segments; these
    // fields let the supervisor resume the same branch for hours or days while
    // the UI reports real state rather than an elapsed-time guess.
    originThreadId: v.optional(v.string()),
    originTurnId: v.optional(v.string()),
    // conversation = Daniel explicitly asked for this work; system = routine
    // maintenance/monitoring. System work remains observable in project and
    // agent views but does not occupy the live conversation strip.
    visibility: v.optional(v.union(v.literal("conversation"), v.literal("system"))),
    agentId: v.optional(v.string()),
    risk: v.optional(v.string()), // low | medium | high | consequential
    priority: v.optional(v.number()), // 0-100
    approvalRequired: v.optional(v.boolean()),
    approvalReason: v.optional(v.string()),
    approvalStatus: v.optional(v.string()), // pending | approved | declined
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    // Liveness and progress deliberately have separate clocks. A worker can
    // still be alive while making no durable, causal progress.
    progressAt: v.optional(v.number()),
    stallCount: v.optional(v.number()),
    stalledAt: v.optional(v.number()),
    stallReason: v.optional(v.string()),
    steer: v.optional(v.string()),
    steerRevision: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()), // retry/continuation eligibility; prevents hot-loop retries
    // Trigger-native fleet dispatch. A short reservation fences one exact job
    // before its independent cloud run is created; the worker run id then
    // connects Trigger Realtime to the durable Convex work record.
    dispatchId: v.optional(v.string()),
    // Snapshot produced by the claim transaction. Exact redelivery returns
    // this immutable envelope rather than re-reading changing upstream work.
    upstreamEvidence: v.optional(v.array(v.object({
      label: v.string(), status: v.string(), result: v.string(), verificationNote: v.string(),
      planDigest: v.optional(v.string()), planGeneration: v.optional(v.number()),
      sourceNodeId: v.optional(v.string()), sourceJobId: v.optional(v.string()),
      sourceAttempt: v.optional(v.number()), sourceSteerRevision: v.optional(v.number()),
      reviewReceiptDigest: v.optional(v.string()), integrationReceiptDigest: v.optional(v.string()),
      repository: v.optional(v.string()), sourceBranch: v.optional(v.string()), sourceHeadSha: v.optional(v.string()),
      integrationBranch: v.optional(v.string()), integrationHeadSha: v.optional(v.string()),
      artifactRefs: v.optional(v.array(v.string())), resultDigest: v.optional(v.string()),
    }))),
    dispatchLeaseUntil: v.optional(v.number()),
    dispatchReason: v.optional(v.string()),
    workerRunId: v.optional(v.string()),
    workerRuntime: v.optional(v.string()),
    providerRunState: v.optional(v.string()),
    providerObservedAt: v.optional(v.number()),
    checkpoint: v.optional(v.string()),
    attempt: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    parentJobId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    // Immutable parent-plan binding for executable Goal Mode DAG nodes. A job
    // may live in a repository child mission, but this authority never moves.
    planParentMissionId: v.optional(v.id("missions")),
    planDigest: v.optional(v.string()),
    planGeneration: v.optional(v.number()),
    planNodeId: v.optional(v.string()),
    goalStage: v.optional(v.string()), // planning | building | validating | refining
    goalWorkstreamId: v.optional(v.string()),
    goalWave: v.optional(v.number()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    modelReason: v.optional(v.string()),
    // Immutable work-item isolation identities. `branch` remains the legacy
    // display/transport alias for workerBranch during the rollout.
    sourceBranch: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    integrationAttemptId: v.optional(v.id("integrationAttempts")),
    integrationState: v.optional(v.string()),
    evidenceSummary: v.optional(v.string()),
    branch: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    // read_only = evidence only; auto_merge = the delivery controller merges
    // a verified branch in Daniel's org; manual = protected external action.
    deliveryMode: v.optional(v.string()),
    deliveryStatus: v.optional(v.string()), // branch | pull_request | merged | blocked
    mergeCommitSha: v.optional(v.string()),
    mergedAt: v.optional(v.number()),
    // Monotonic controller linearization token for consequential delivery.
    deliveryLeaseVersion: v.optional(v.number()),
    // Delivery retries are distinct from specialist work attempts. They retain
    // a pointer to the immutable source review without relabelling it.
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    // The active controller generation is an authority pointer, not merely
    // display state.  A specialist never owns this row after review.
    activeDeliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    // Controller-owned delivery lease.  The opaque token never reaches an
    // agent sandbox; its version makes stale controller writes harmless.
    deliveryLeaseOwner: v.optional(v.string()),
    deliveryLeaseToken: v.optional(v.string()),
    deliveryLeaseUntil: v.optional(v.number()),
    // One job-wide causal cursor. Attempt cursors are retained for rolling
    // compatibility, but new events are ordered against this single cursor.
    lifecycleSequence: v.optional(v.number()),
    lifecycleEventKey: v.optional(v.string()),
    // A signed controller receipt is persisted before repository delivery.
    reviewReceiptJson: v.optional(v.string()),
    reviewReceiptSignature: v.optional(v.string()),
    // Compact pointer only. The potentially large immutable review document
    // lives in reviewReceipts, never on this hot control document.
    reviewReceiptId: v.optional(v.id("reviewReceipts")),
    reviewReceiptDigest: v.optional(v.string()),
    verificationVerdict: v.optional(v.string()), // pass | unavailable
    verificationNote: v.optional(v.string()),
    verifiedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_status_next_run", ["status", "nextRunAt"])
    .index("by_mission", ["missionId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_agent", ["agentId", "createdAt"])
    .index("by_visibility_status", ["visibility", "status", "createdAt"]),

  // Compact control-plane read model. Live subscriptions, scheduler polls and
  // execution lease checks use this table instead of materialising the much
  // larger durable jobs (task/result/checkpoint/transcript). Durable state
  // transitions still commit to jobs and update this projection atomically.
  jobRuntime: defineTable({
    jobId: v.id("jobs"),
    task: v.string(),
    label: v.optional(v.string()),
    repo: v.optional(v.string()),
    status: v.string(),
    visibility: v.optional(v.string()),
    incidentId: v.optional(v.string()),
    missionId: v.optional(v.string()),
    originThreadId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    modelReason: v.optional(v.string()),
    risk: v.optional(v.string()),
    priority: v.number(),
    approvalRequired: v.optional(v.boolean()),
    approvalStatus: v.optional(v.string()),
    stage: v.string(),
    percent: v.number(),
    progress: v.optional(v.string()),
    // Optional during the first projection rollout. The bounded migration
    // supplies these values before a later schema-tightening release.
    progressAt: v.optional(v.number()),
    stallCount: v.optional(v.number()),
    stalledAt: v.optional(v.number()),
    stallReason: v.optional(v.string()),
    steerRevision: v.optional(v.number()),
    // A compact one-index read model for live UI work. This stays optional in
    // rollout one so existing runtime rows remain schema-valid.
    active: v.optional(v.boolean()),
    attempt: v.number(),
    maxAttempts: v.number(),
    heartbeatAt: v.number(),
    nextRunAt: v.optional(v.number()),
    dispatchId: v.optional(v.string()),
    dispatchLeaseUntil: v.optional(v.number()),
    workerRunId: v.optional(v.string()),
    workerRuntime: v.optional(v.string()),
    providerRunState: v.optional(v.string()),
    providerObservedAt: v.optional(v.number()),
    readonly: v.optional(v.boolean()),
    parentJobId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    planParentMissionId: v.optional(v.id("missions")),
    planDigest: v.optional(v.string()),
    planGeneration: v.optional(v.number()),
    planNodeId: v.optional(v.string()),
    goalStage: v.optional(v.string()),
    goalWorkstreamId: v.optional(v.string()),
    goalWave: v.optional(v.number()),
    sourceBranch: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    integrationAttemptId: v.optional(v.id("integrationAttempts")),
    integrationState: v.optional(v.string()),
    evidenceSummary: v.optional(v.string()),
    branch: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    deliveryMode: v.optional(v.string()),
    deliveryStatus: v.optional(v.string()),
    mergeCommitSha: v.optional(v.string()),
    deliveryLeaseVersion: v.optional(v.number()),
    deliveryGeneration: v.optional(v.number()),
    deliveryRunId: v.optional(v.string()),
    deliveryLeaseUntil: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status_priority", ["status", "priority", "createdAt"])
    .index("by_status_next_run", ["status", "nextRunAt", "createdAt"])
    .index("by_status_heartbeat", ["status", "heartbeatAt"])
    .index("by_status_progress", ["status", "progressAt"])
    .index("by_status_dispatch_lease", ["status", "dispatchLeaseUntil"])
    .index("by_active_priority", ["active", "priority", "createdAt"])
    .index("by_visibility_status_priority", ["visibility", "status", "priority", "createdAt"])
    .index("by_thread_visibility_status_priority", ["originThreadId", "visibility", "status", "priority", "createdAt"])
    .index("by_thread_visibility_active_priority", ["originThreadId", "visibility", "active", "priority", "createdAt"])
    .index("by_plan_parent_generation_node", ["planParentMissionId", "planGeneration", "planNodeId"])
    .index("by_mission", ["missionId", "createdAt"]),

  // Orchestrated agent fleets: one mission = a decomposed goal running as
  // parallel jobs; when the last one lands, a synthesis pass merges the
  // results into ONE coherent report back to Daniel.
  missions: defineTable({
    goal: v.string(),
    status: v.string(), // running | synthesizing | done | failed
    mode: v.optional(v.string()), // fleet | goal
    agentCount: v.number(),
    summary: v.optional(v.string()),
    originThreadId: v.optional(v.string()),
    managerAgentId: v.optional(v.string()),
    parentMissionId: v.optional(v.id("missions")),
    splitChildMissionIds: v.optional(v.array(v.id("missions"))),
    splitChildKind: v.optional(v.string()),
    planDigest: v.optional(v.string()),
    planGeneration: v.optional(v.number()),
    planNodeCount: v.optional(v.number()),
    controlRequested: v.optional(v.string()),
    controlRequestedAt: v.optional(v.number()),
    steer: v.optional(v.string()),
    steerRevision: v.optional(v.number()),
    priority: v.optional(v.number()),
    risk: v.optional(v.string()),
    phase: v.optional(v.string()),
    percent: v.optional(v.number()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    route: v.optional(v.string()),
    routeReason: v.optional(v.string()),
    primaryRepo: v.optional(v.string()),
    infrastructureContext: v.optional(v.string()),
    plan: v.optional(v.any()),
    validation: v.optional(v.any()),
    validationHistory: v.optional(v.array(v.any())),
    planningJobId: v.optional(v.string()),
    validatorJobId: v.optional(v.string()),
    sharedBranch: v.optional(v.string()),
    // `sharedBranch` is legacy display state. Only integrationBranch may be
    // advanced, and only by the fenced integration queue below.
    sourceBranch: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    integrationHeadSha: v.optional(v.string()),
    integrationGeneration: v.optional(v.number()),
    activeIntegrationAttemptId: v.optional(v.id("integrationAttempts")),
    integrationLeaseOwner: v.optional(v.string()),
    integrationLeaseToken: v.optional(v.string()),
    integrationLeaseVersion: v.optional(v.number()),
    integrationLeaseUntil: v.optional(v.number()),
    revisionWave: v.optional(v.number()),
    maxRevisionWaves: v.optional(v.number()),
    maxBuildSessions: v.optional(v.number()),
    advanceAttempt: v.optional(v.number()),
    // Goal result parsing and external handoff are a separate durable control
    // boundary.  Fence its owner just like delivery/integration so a quiet or
    // restarted Trigger turn cannot commit an old planner/validator output.
    advanceLeaseOwner: v.optional(v.string()),
    advanceLeaseToken: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()),
    advanceLeaseHeartbeatAt: v.optional(v.number()),
    advanceLeaseUntil: v.optional(v.number()),
    pausedPhase: v.optional(v.string()),
    pendingRefinements: v.optional(v.any()),
    failureReason: v.optional(v.string()),
    externalKind: v.optional(v.string()),
    externalRunId: v.optional(v.string()),
    externalSlug: v.optional(v.string()),
    externalStatus: v.optional(v.string()),
    externalStage: v.optional(v.string()),
    externalUpdatedAt: v.optional(v.number()),
    externalPollFailures: v.optional(v.number()),
    externalPollError: v.optional(v.string()),
    externalPollAlertedAt: v.optional(v.number()),
    externalControlRequested: v.optional(v.string()),
    externalControlUpdatedAt: v.optional(v.number()),
    externalRevisionRequested: v.optional(v.string()),
    externalRevisionWave: v.optional(v.number()),
    externalRevisionUpdatedAt: v.optional(v.number()),
    externalActionFailures: v.optional(v.number()),
    externalActionError: v.optional(v.string()),
    externalActionAlertedAt: v.optional(v.number()),
    synthesisAttempt: v.optional(v.number()),
    synthesisLeaseUntil: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_external_control", ["externalControlRequested", "createdAt"])
    .index("by_external_revision", ["externalRevisionRequested", "createdAt"]),

  // Mission list/status projection. Rich plans, validation histories and final
  // reports remain in missions and are fetched only by the dedicated detail
  // query, so a job heartbeat cannot amplify into a reread of those payloads.
  missionRuntime: defineTable({
    missionId: v.id("missions"),
    goal: v.string(),
    mode: v.string(),
    status: v.string(),
    agentCount: v.number(),
    originThreadId: v.optional(v.string()),
    managerAgentId: v.optional(v.string()),
    priority: v.number(),
    phase: v.string(),
    percent: v.number(),
    route: v.optional(v.string()),
    primaryRepo: v.optional(v.string()),
    revisionWave: v.number(),
    maxRevisionWaves: v.number(),
    maxBuildSessions: v.number(),
    planningJobId: v.optional(v.string()),
    validatorJobId: v.optional(v.string()),
    planDigest: v.optional(v.string()),
    planGeneration: v.optional(v.number()),
    planNodeCount: v.optional(v.number()),
    sourceBranch: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    integrationHeadSha: v.optional(v.string()),
    integrationGeneration: v.optional(v.number()),
    activeIntegrationAttemptId: v.optional(v.id("integrationAttempts")),
    integrationLeaseUntil: v.optional(v.number()),
    advanceLeaseOwner: v.optional(v.string()),
    advanceLeaseVersion: v.optional(v.number()),
    advanceLeaseHeartbeatAt: v.optional(v.number()),
    advanceLeaseUntil: v.optional(v.number()),
    pausedPhase: v.optional(v.string()),
    failureReason: v.optional(v.string()),
    externalKind: v.optional(v.string()),
    externalRunId: v.optional(v.string()),
    externalSlug: v.optional(v.string()),
    externalStatus: v.optional(v.string()),
    externalStage: v.optional(v.string()),
    externalPollFailures: v.number(),
    externalControlRequested: v.optional(v.string()),
    externalRevisionRequested: v.optional(v.string()),
    externalRevisionWave: v.optional(v.number()),
    externalActionFailures: v.number(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_mission", ["missionId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_external_control", ["externalControlRequested", "createdAt"])
    .index("by_external_revision", ["externalRevisionRequested", "createdAt"]),

  // Resumable cursors make the legacy backfill and policy repairs one-time,
  // bounded work. Once both cursors finish, minute maintenance reads this one
  // tiny row and performs no historical scan.
  controlPlaneMigrations: defineTable({
    key: v.string(),
    jobsCursor: v.optional(v.string()),
    jobsComplete: v.boolean(),
    jobsScanned: v.number(),
    jobsRepaired: v.number(),
    missionsCursor: v.optional(v.string()),
    missionsComplete: v.boolean(),
    missionsScanned: v.number(),
    missionsRepaired: v.number(),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // One-time bounded cursor for assigning indexed ownership to legacy
  // proactive attention rows. The recurring reconciler never falls back to a
  // whole-table scan while this rollout is incomplete.
  attentionAuthorityMigrations: defineTable({
    key: v.string(),
    cursor: v.optional(v.string()),
    complete: v.boolean(),
    scanned: v.number(),
    repaired: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Opaque, revocable browser sessions for Daniel. The raw bearer token only
  // exists in an HttpOnly cookie; Convex stores its SHA-256 digest. Privileged
  // user mutations require a live digest, while Trigger uses a separate
  // server-held worker capability.
  adminSessions: defineTable({
    tokenHash: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_expiry", ["expiresAt"]),

  // Short-lived, read-only capabilities issued only after an HttpOnly admin
  // session is validated. The browser may hold this scoped token in memory,
  // but the admin bearer never leaves its cookie and mutations reject viewers.
  viewerSessions: defineTable({
    token: v.string(),
    adminTokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_admin", ["adminTokenHash"])
    .index("by_expiry", ["expiresAt"]),

  // Permanent team roster. These are durable identities with stable roles,
  // scope and model policy; jobs reference the profile rather than inventing
  // an anonymous agent on every turn.
  agentProfiles: defineTable({
    slug: v.string(),
    name: v.string(),
    role: v.string(),
    description: v.string(),
    capabilities: v.array(v.string()),
    projectScopes: v.array(v.string()),
    defaultModel: v.string(),
    autonomy: v.string(),
    status: v.string(), // available | working | blocked | offline
    currentJobId: v.optional(v.string()),
    completedJobs: v.number(),
    failedJobs: v.number(),
    averageDurationMs: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_status", ["status", "updatedAt"]),

  // Append-only execution journal. The rolling log remains convenient, while
  // events make stage history, supervision and post-mortems reliable.
  workEvents: defineTable({
    jobId: v.optional(v.string()),
    missionId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    type: v.string(),
    message: v.string(),
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    // Event fields are write-once evidence. Causation is optional while old
    // rows age out, but every new attempt transition supplies it.
    attempt: v.optional(v.number()),
    causationId: v.optional(v.string()),
    evidenceKind: v.optional(v.string()),
    eventKey: v.optional(v.string()),
    sequence: v.optional(v.number()),
    predecessorKey: v.optional(v.string()),
    data: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId", "createdAt"])
    .index("by_mission", ["missionId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_job_event", ["jobId", "eventKey"])
    .index("by_job_sequence", ["jobId", "sequence", "createdAt"]),

  // One immutable row per fenced Trigger attempt. Jobs remain the authority
  // for scheduling; this table makes intent → workspace → session lineage
  // auditable without putting a second control plane beside Convex.
  workAttempts: defineTable({
    jobId: v.id("jobs"),
    attempt: v.number(),
    status: v.string(), // queued | dispatching | running | checkpointed | paused | steered | needs_input | stalled | done | error | cancelled
    // A lifecycle record is created while queued. Launch identities remain
    // optional until the exact dispatch crosses the worker fence, allowing
    // every event from enqueue onward to use one causal cursor.
    workspaceKey: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    workerRunId: v.optional(v.string()),
    dispatchId: v.optional(v.string()),
    parentAttempt: v.optional(v.number()),
    sourceHeadSha: v.optional(v.string()),
    workspaceBaseSha: v.optional(v.string()),
    parentCheckpointHeadSha: v.optional(v.string()),
    checkpointHeadSha: v.optional(v.string()),
    // Immutable claim envelope. Exact Trigger redelivery returns this exact
    // snapshot and must never re-read changing dependencies.
    upstreamEvidence: v.optional(v.array(v.object({
      label: v.string(), status: v.string(), result: v.string(), verificationNote: v.string(),
      planDigest: v.optional(v.string()), planGeneration: v.optional(v.number()),
      sourceNodeId: v.optional(v.string()), sourceJobId: v.optional(v.string()),
      sourceAttempt: v.optional(v.number()), sourceSteerRevision: v.optional(v.number()),
      reviewReceiptDigest: v.optional(v.string()), integrationReceiptDigest: v.optional(v.string()),
      repository: v.optional(v.string()), sourceBranch: v.optional(v.string()), sourceHeadSha: v.optional(v.string()),
      integrationBranch: v.optional(v.string()), integrationHeadSha: v.optional(v.string()),
      artifactRefs: v.optional(v.array(v.string())), resultDigest: v.optional(v.string()),
    }))),
    // The Trigger run is only delivery metadata. Sandbox/provider sessions
    // are deliberately separate identities for the sandbox adapter workstream.
    providerName: v.optional(v.string()),
    providerWorkspaceId: v.optional(v.string()),
    providerSessionId: v.optional(v.string()),
    providerCreatedAt: v.optional(v.number()),
    providerTerminatedAt: v.optional(v.number()),
    workspaceRuntime: v.optional(v.string()),
    workspaceLockfileDigest: v.optional(v.string()),
    workspaceTemplate: v.optional(v.string()),
    sourceArchiveDigest: v.optional(v.string()),
    sourceArchiveBytes: v.optional(v.number()),
    checkpointRef: v.optional(v.string()),
    checkpointDigest: v.optional(v.string()),
    checkpointBytes: v.optional(v.number()),
    checkpointManifestDigest: v.optional(v.string()),
    checkpointManifest: v.optional(v.string()),
    // This write-once marker is the replay lookup authority. It is set in
    // the same mutation as the complete immutable receipt so replay never
    // has to scan historical attempts or infer availability from fragments.
    checkpointAvailable: v.optional(v.boolean()),
    cleanupBlockedCode: v.optional(v.string()),
    cleanupBlockedReason: v.optional(v.string()),
    cleanupBlockedAt: v.optional(v.number()),
    lastEventSeq: v.optional(v.number()),
    lastEventKey: v.optional(v.string()),
    launchedAt: v.optional(v.number()),
    livenessAt: v.number(),
    progressAt: v.number(),
    lastEventAt: v.number(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_job_attempt", ["jobId", "attempt"])
    .index("by_job_checkpoint_available_attempt", ["jobId", "checkpointAvailable", "attempt"])
    .index("by_status_progress", ["status", "progressAt"]),

  // Accepted GoalPlan authority is normalized once. These compact rows map
  // every original id exactly once to its executable job and repository/evidence
  // child without making mission summaries or heartbeats authoritative.
  goalPlanNodes: defineTable({
    parentMissionId: v.id("missions"),
    planDigest: v.string(),
    planGeneration: v.number(),
    nodeId: v.string(),
    childMissionId: v.id("missions"),
    jobId: v.id("jobs"),
    label: v.string(),
    agentId: v.string(),
    repository: v.optional(v.string()),
    readonly: v.boolean(),
    dependencyCount: v.number(),
    weight: v.number(),
    createdAt: v.number(),
  })
    .index("by_parent_generation", ["parentMissionId", "planGeneration", "nodeId"])
    .index("by_parent_generation_node", ["parentMissionId", "planGeneration", "nodeId"])
    .index("by_child", ["childMissionId", "nodeId"])
    .index("by_job", ["jobId"]),

  goalPlanEdges: defineTable({
    parentMissionId: v.id("missions"),
    planDigest: v.string(),
    planGeneration: v.number(),
    edgeId: v.string(),
    sourceNodeId: v.string(),
    targetNodeId: v.string(),
    sourceJobId: v.id("jobs"),
    targetJobId: v.id("jobs"),
    createdAt: v.number(),
  })
    .index("by_parent_generation", ["parentMissionId", "planGeneration", "edgeId"])
    .index("by_target", ["targetJobId", "planGeneration", "sourceNodeId"])
    .index("by_source", ["sourceJobId", "planGeneration", "targetNodeId"]),

  // One compact immutable receipt per successful node execution generation.
  // Full reviews, integration manifests and artifacts remain in their cold
  // authority tables and are loaded only by validators or explicit detail UI.
  goalHandoffs: defineTable({
    parentMissionId: v.id("missions"),
    planDigest: v.string(),
    planGeneration: v.number(),
    sourceNodeId: v.string(),
    sourceJobId: v.id("jobs"),
    sourceAttempt: v.number(),
    sourceSteerRevision: v.number(),
    reviewReceiptDigest: v.optional(v.string()),
    integrationReceiptDigest: v.optional(v.string()),
    repository: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    integrationHeadSha: v.optional(v.string()),
    artifactRefs: v.array(v.string()),
    resultDigest: v.string(),
    summary: v.string(),
    createdAt: v.number(),
  })
    .index("by_source_attempt", ["sourceJobId", "sourceAttempt", "planGeneration"])
    .index("by_parent_generation", ["parentMissionId", "planGeneration", "sourceNodeId"]),

  // Mission integration is distinct from specialist delivery. These rows are
  // append-only generations around one immutable review receipt. Exactly one
  // row per mission can hold the controller lease and advance the integration
  // ref; conflicts create focused repair jobs instead of replaying siblings.
  integrationAttempts: defineTable({
    missionId: v.id("missions"),
    jobId: v.id("jobs"),
    workAttempt: v.number(),
    generation: v.number(),
    revisionWave: v.number(),
    workstreamId: v.string(),
    repository: v.string(),
    sourceBranch: v.string(),
    workerBranch: v.string(),
    integrationBranch: v.string(),
    reviewReceiptId: v.id("reviewReceipts"),
    reviewReceiptDigest: v.string(),
    reviewedBaseSha: v.string(),
    reviewedHeadSha: v.string(),
    reviewedHeadTreeSha: v.string(),
    reviewedDiffSha256: v.string(),
    status: v.string(), // queued | claimed | prepared | provider_waiting | integrated | conflict | stale | cancelled
    controllerRunId: v.optional(v.string()),
    leaseOwner: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseVersion: v.number(),
    leaseUntil: v.optional(v.number()),
    expectedIntegrationBaseSha: v.optional(v.string()),
    // Exact persisted old ref identity for GitHub updateRefs. The zero OID is
    // used only when the mission integration ref was intentionally absent.
    expectedIntegrationRefSha: v.optional(v.string()),
    preparedEffectId: v.optional(v.string()),
    preparedIntegrationHeadSha: v.optional(v.string()),
    preparedIntegrationTreeSha: v.optional(v.string()),
    providerObservation: v.optional(v.string()),
    providerObservedHeadSha: v.optional(v.string()),
    providerEffectCount: v.optional(v.number()),
    controllerState: v.optional(v.string()),
    controllerStateSince: v.optional(v.number()),
    controllerDeadlineAt: v.optional(v.number()),
    controllerHeartbeatAt: v.optional(v.number()),
    controlRequested: v.optional(v.string()), // pause | cancel | steer
    controlRequestedAt: v.optional(v.number()),
    reconcileAfter: v.optional(v.number()),
    // Set only when bounded automatic reconciliation yields to Daniel. The
    // attempt remains a nonterminal FIFO head and resume clears this marker.
    reconciliationAttentionAt: v.optional(v.number()),
    effects: v.optional(v.array(v.object({
      effectId: v.string(),
      effectKind: v.string(),
      provider: v.string(),
      providerIdentity: v.string(),
      providerMethod: v.string(),
      providerTarget: v.string(),
      requestDigest: v.string(),
      expectedBaseSha: v.optional(v.string()),
      headSha: v.string(),
      treeSha: v.string(),
      preparedAt: v.number(),
      observation: v.optional(v.string()),
      providerHeadSha: v.optional(v.string()),
      providerResponse: v.optional(v.string()),
      observedAt: v.optional(v.number()),
    }))),
    outcome: v.optional(v.string()),
    retryReason: v.optional(v.string()),
    cumulativeRetries: v.number(),
    repairJobId: v.optional(v.id("jobs")),
    terminalReceiptDigest: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_mission_status", ["missionId", "status", "createdAt"])
    .index("by_mission_generation", ["missionId", "generation"])
    .index("by_job_attempt", ["jobId", "workAttempt"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_mission_repository_status_generation", ["missionId", "repository", "status", "generation"]),

  // Provider writes are cold, independently replayable effects. Integration
  // attempts retain only compact pointers/state so large exact responses and
  // long object-staging lineages never inflate dispatch/heartbeat documents.
  integrationProviderEffects: defineTable({
    integrationAttemptId: v.id("integrationAttempts"),
    effectId: v.string(),
    effectKind: v.string(),
    provider: v.string(),
    providerIdentity: v.string(),
    providerMethod: v.string(),
    providerTarget: v.string(),
    requestDigest: v.string(),
    expectedBaseSha: v.optional(v.string()),
    headSha: v.string(),
    treeSha: v.string(),
    preparedAt: v.number(),
    observation: v.optional(v.string()),
    providerHeadSha: v.optional(v.string()),
    providerResponse: v.optional(v.string()),
    providerResponseDigest: v.optional(v.string()),
    observedAt: v.optional(v.number()),
  })
    .index("by_attempt_effect", ["integrationAttemptId", "effectId"])
    .index("by_attempt_prepared", ["integrationAttemptId", "preparedAt"]),

  // Full canonical integration terminal evidence is cold and append-only.
  // Hot mission/job/attempt rows retain only outcome and digest pointers.
  integrationTerminalReceipts: defineTable({
    missionId: v.id("missions"),
    jobId: v.id("jobs"),
    integrationAttemptId: v.id("integrationAttempts"),
    outcome: v.string(),
    receiptJson: v.string(),
    receiptDigest: v.string(),
    createdAt: v.number(),
  })
    .index("by_attempt", ["integrationAttemptId"])
    .index("by_mission", ["missionId", "createdAt"])
    .index("by_digest", ["receiptDigest"]),

  // Controller delivery has its own durable lease lineage.  It deliberately
  // points at an immutable specialist attempt rather than reusing that
  // attempt's running/liveness state while GitHub checks are pending.
  deliveryAttempts: defineTable({
    jobId: v.id("jobs"),
    integrationAttemptId: v.optional(v.id("integrationAttempts")),
    sourceWorkAttempt: v.number(),
    generation: v.number(),
    // These are assigned only when the controller generation is dispatched.
    // A queued cold receipt deliberately has no Trigger identity yet.
    dispatchId: v.optional(v.string()),
    deliveryRunId: v.optional(v.string()),
    policy: v.string(),
    status: v.string(), // running | checkpointed | done | blocked | abandoned
    // The controller row is the complete authority record. Job fields are
    // projections only and cannot authorize a provider effect.
    outcome: v.optional(v.string()),
    sourceDispatchId: v.optional(v.string()),
    parentDeliveryAttemptId: v.optional(v.id("deliveryAttempts")),
    reviewLineage: v.optional(v.array(v.object({
      sourceWorkAttempt: v.number(),
      reviewReceiptId: v.id("reviewReceipts"),
      reviewReceiptDigest: v.string(),
      keyId: v.optional(v.string()),
    }))),
    reviewReceiptId: v.optional(v.id("reviewReceipts")),
    reviewReceiptDigest: v.optional(v.string()),
    reviewKeyId: v.optional(v.string()),
    reviewedHeadSha: v.optional(v.string()),
    reviewedBaseSha: v.optional(v.string()),
    reviewedHeadTreeSha: v.optional(v.string()),
    reviewedDiffSha256: v.optional(v.string()),
    observedPullRequestHead: v.optional(v.string()),
    observedPullRequestBase: v.optional(v.string()),
    pullRequestNumber: v.optional(v.number()),
    pullRequestUrl: v.optional(v.string()),
    pullRequestNodeId: v.optional(v.string()),
    pullRequestDraft: v.optional(v.boolean()),
    preparedEffectId: v.optional(v.string()),
    preparedEffectKind: v.optional(v.string()), // create_draft_pr | create_pr | promote_pr | merge_pr
    preparedEffectAt: v.optional(v.number()),
    providerObservation: v.optional(v.string()),
    providerObservedAt: v.optional(v.number()),
    effects: v.optional(v.array(v.object({
      effectId: v.string(), effectKind: v.string(), preparedAt: v.number(),
      reviewedHeadSha: v.string(), reviewedBaseSha: v.string(),
      pullRequestNumber: v.optional(v.number()),
      observation: v.optional(v.string()), observedAt: v.optional(v.number()),
      pullRequestUrl: v.optional(v.string()), pullRequestNodeId: v.optional(v.string()),
      pullRequestDraft: v.optional(v.boolean()), observedPullRequestHead: v.optional(v.string()),
      observedPullRequestBase: v.optional(v.string()), mergeCommitSha: v.optional(v.string()),
    }))),
    mergeCommitSha: v.optional(v.string()),
    retryReason: v.optional(v.string()),
    leaseOwner: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseVersion: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    heartbeatAt: v.number(),
    retries: v.number(),
    // Retry budget belongs to the immutable review lineage and is copied
    // forward; resetting it on every generation made the cap unreachable.
    cumulativeRetries: v.optional(v.number()),
    currentStep: v.optional(v.string()), // queued | preflight | prepared | observing | receipt | terminal
    terminalReceiptDigest: v.optional(v.string()),
    nextRunAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_job", ["jobId", "generation"])
    .index("by_job_source_generation", ["jobId", "sourceWorkAttempt", "generation"])
    .index("by_status_heartbeat", ["status", "heartbeatAt"]),

  // Receipts are only inserted by terminal authority transitions and are
  // never patched. They bind acceptance evidence and artifacts to one exact
  // attempt, closing the replay/substitution gap at completion.
  workReceipts: defineTable({
    jobId: v.id("jobs"),
    attempt: v.number(),
    status: v.string(),
    acceptanceEvidence: v.array(v.string()),
    artifacts: v.array(v.string()),
    verification: v.string(),
    deliveryOutcome: v.optional(v.string()),
    terminalEventKey: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    evidenceDigest: v.optional(v.string()),
    // Controller-issued signed review binding for repository work.
    reviewReceiptSignature: v.optional(v.string()),
    reviewDiffSha256: v.optional(v.string()),
    reviewReceiptId: v.optional(v.id("reviewReceipts")),
    reviewReceiptDigest: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_job_attempt", ["jobId", "attempt"])
    .index("by_createdAt", ["createdAt"]),

  // Cold, append-only repository review evidence. It is content-addressed
  // and never patched; jobs retain only the small binding fields above.
  reviewReceipts: defineTable({
    jobId: v.id("jobs"),
    attempt: v.number(),
    repository: v.string(),
    workerBranch: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    receiptJson: v.string(),
    receiptDigest: v.string(),
    signature: v.string(),
    keyId: v.optional(v.string()),
    diffSha256: v.string(),
    baseSha: v.string(),
    headSha: v.string(),
    baseTreeSha: v.string(),
    headTreeSha: v.string(),
    agentEvidenceSha256: v.string(),
    createdAt: v.number(),
  })
    .index("by_job_attempt", ["jobId", "attempt"])
    .index("by_job_attempt_digest", ["jobId", "attempt", "receiptDigest"]),

  // Compact, append-only supervisor receipts. These deliberately describe
  // coordination rather than changing it, so viewers can audit Trigger's
  // five-minute Goal Mode owner without receiving a control capability.
  goalCoordinatorReceipts: defineTable({
    deploymentVersion: v.string(),
    demandNeeded: v.boolean(),
    demandReasons: v.array(v.string()),
    demandError: v.optional(v.string()),
    controlsChecked: v.number(),
    controlsApplied: v.number(),
    controlsBlocked: v.number(),
    controlsError: v.optional(v.string()),
    revisionsChecked: v.number(),
    revisionsApplied: v.number(),
    revisionsBlocked: v.number(),
    revisionsError: v.optional(v.string()),
    externalChecked: v.number(),
    externalUpdated: v.number(),
    externalBlocked: v.number(),
    externalError: v.optional(v.string()),
    wakeRequested: v.boolean(),
    wakeResult: v.string(), // not_requested | dispatched | not_dispatched
    wakeTarget: v.optional(v.string()),
    // Historical GitHub-harness receipt fields. New receipts use wakeTarget;
    // retain these optional fields until old production documents age out.
    wakeWorkflow: v.optional(v.string()),
    wakeRef: v.optional(v.string()),
    wakeReason: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // Consequential work is suspended here until Daniel explicitly approves or
  // declines it. Approval changes are separate from execution logs for audit.
  approvals: defineTable({
    jobId: v.string(),
    kind: v.string(),
    summary: v.string(),
    risk: v.string(),
    payload: v.optional(v.any()),
    status: v.string(), // pending | approved | declined | expired
    requestedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_status", ["status", "requestedAt"])
    .index("by_job", ["jobId"]),

  // Ranked, evidence-carrying attention queue. This replaces generic insight
  // spam with a small list of decisions, blockers and safe suggested fixes.
  attentionItems: defineTable({
    fingerprint: v.string(),
    project: v.optional(v.string()),
    title: v.string(),
    detail: v.string(),
    evidence: v.optional(v.array(v.string())),
    severity: v.string(),
    impact: v.number(),
    urgency: v.number(),
    confidence: v.number(),
    actionClass: v.string(), // inform | ask | propose | safe-auto-fix
    authority: v.optional(v.string()),
    status: v.string(), // open | working | resolved | dismissed
    jobId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_authority_status", ["authority", "status", "updatedAt"])
    .index("by_fingerprint", ["fingerprint"])
    .index("by_jobId", ["jobId"])
    .index("by_updatedAt", ["updatedAt"]),

  // "Show me" panel — the brain sets what to display (site / doc / image); the UI
  // reactively shows it in place of the orb. Single row keyed "panel".
  ui: defineTable({
    key: v.string(),
    type: v.string(), // "url" | "markdown" | "image"
    value: v.string(),
    title: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Web-push subscriptions (per device) — JARVIS pings the phone even when closed.
  pushSubs: defineTable({
    endpoint: v.string(),
    keys: v.object({ p256dh: v.string(), auth: v.string() }),
    createdAt: v.number(),
  }).index("by_endpoint", ["endpoint"]),

  // Live business intelligence: pollers pull real metrics (rentals, per-item
  // earnings, YouTube, music sales, wealth) into per-domain snapshots the brain
  // injects so JARVIS naturally knows how everything is doing. The "web of intel".
  businessState: defineTable({
    domain: v.string(), // "rental" | "youtube" | "music" | "wealth" | "ads"
    headline: v.string(), // one-line spoken summary
    detail: v.optional(v.string()), // richer detail for when asked
    data: v.optional(v.any()), // structured payload for future UI
    updatedAt: v.number(),
  }).index("by_domain", ["domain"]),

  // Background-agent findings waiting to be woven into conversation. The runner
  // writes a short spoken line + full detail; the brain speaks the line naturally
  // and can push the detail to the panel on request. status: fresh -> woven.
  findings: defineTable({
    source: v.string(), // task description that produced it
    spoken: v.string(), // one natural sentence JARVIS can say
    detail: v.string(), // full result, panel-able
    status: v.string(), // "fresh" | "woven"
    createdAt: v.number(),
    bullets: v.optional(v.array(v.string())), // distilled card breakdown
    important: v.optional(v.boolean()), // relevance gate for popup cards
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // Self-healing: anything that breaks (client errors, route failures, dead
  // deploys, brain-reported malfunctions) lands here; the healer turns open
  // incidents into root-cause repair jobs with attempt caps.
  incidents: defineTable({
    source: v.string(), // "client" | "api/chat" | "api/tools" | "stack-poller" | "agent-runner" | "brain"
    app: v.optional(v.string()), // affected repo/app (default jarvis)
    signature: v.string(), // dedup key
    message: v.string(),
    count: v.number(),
    status: v.string(), // "open" | "dispatched" | "resolved" | "needs-daniel"
    attempts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_signature", ["signature"]),

  // Everything JARVIS creates (mind maps, charts, images, PDFs, docs) lives
  // here — his atelier. `data` is the editable source (JSON/markdown); `url`
  // points at the stored artifact in R2 when there is one.
  creations: defineTable({
    kind: v.string(), // "canvas" | "chart" | "image" | "pdf" | "doc"
    title: v.string(),
    data: v.optional(v.string()), // JSON (canvas/chart) or markdown (doc)
    url: v.optional(v.string()), // R2 public url (image/pdf)
    thumb: v.optional(v.string()), // small preview url if any
    category: v.optional(v.string()), // emails, notes, boards, mind maps, etc.
    folder: v.optional(v.string()), // human-readable hierarchy: Projects / X, Visuals / Boards…
    project: v.optional(v.string()),
    inquiry: v.optional(v.string()),
    threadId: v.optional(v.string()), // conversation that produced the creation
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_kind", ["kind", "updatedAt"])
    .index("by_category", ["category", "updatedAt"])
    .index("by_folder", ["folder", "updatedAt"])
    .index("by_project", ["project", "updatedAt"])
    .index("by_thread", ["threadId", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  // Storage-only archive from the retired model-generated insight loop. The
  // 50 historical rows remain untouched; attentionItems is the live queue.
  insights: defineTable({
    domain: v.string(),
    text: v.string(),
    severity: v.string(), // "info" | "opportunity" | "warning"
    surfaced: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_surfaced", ["surfaced", "createdAt"])
    .index("by_domain", ["domain", "createdAt"]),
});
