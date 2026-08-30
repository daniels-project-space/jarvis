import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const projectSourceAdmission = v.object({
  protocolVersion: v.literal(2),
  canonicalProjectId: v.string(),
  repository: v.optional(v.string()),
  sourceProvider: v.union(v.literal("github"), v.literal("none")),
  sourceBranch: v.optional(v.string()),
  sourceRef: v.optional(v.string()),
  sourceHeadSha: v.optional(v.string()),
  sourceObservedAt: v.number(),
  sourceAdmissionDigest: v.string(),
});

const missionSupervisorStateValidator = v.union(
  v.literal("ready"),
  v.literal("leased"),
  v.literal("waiting"),
  v.literal("paused"),
  v.literal("needs_input"),
  v.literal("terminal"),
);

const missionSupervisorDecisionKindValidator = v.union(
  v.literal("delegate"),
  v.literal("recover"),
  v.literal("wait"),
  v.literal("request_input"),
  v.literal("replan"),
  v.literal("synthesize"),
  v.literal("fail"),
);

const missionSupervisorModelTierValidator = v.union(
  v.literal("luna"),
  v.literal("terra"),
  v.literal("sol"),
);

// This is intentionally an explicit false-only capability snapshot. The
// provider/model transport belongs to the immutable work order, never to a
// mutable job update or environment toggle.
const backgroundExecutionAuthorityValidator = v.object({
  external: v.literal(false),
  apps: v.literal(false),
  secrets: v.literal(false),
  network: v.literal(false),
});

const backgroundExecutionProfileValidator = v.union(
  v.object({
    version: v.literal(1),
    provider: v.literal("codex-subscription"),
    modelTier: missionSupervisorModelTierValidator,
    readonly: v.boolean(),
    authority: backgroundExecutionAuthorityValidator,
    repositoryCapabilities: v.array(v.string()),
  }),
  v.object({
    version: v.literal(2),
    provider: v.literal("codex-subscription"),
    // The untrusted Qwen stage is reviewed by Terra; it never lowers the
    // sealed Codex executor to the draft model's budget tier.
    modelTier: v.literal("terra"),
    readonly: v.boolean(),
    authority: backgroundExecutionAuthorityValidator,
    repositoryCapabilities: v.array(v.string()),
    novitaPatchProposer: v.object({
      adapterId: v.literal("novita-qwen-patch-proposer-v1"),
      configDigest: v.string(),
      endpointId: v.string(),
      modelId: v.string(),
      modelRevision: v.string(),
      imageDigest: v.string(),
      quantization: v.literal("gptq-int4"),
      api: v.literal("openai-chat-completions"),
      endpointAuth: v.literal("hmac-sha256-v1"),
      requestLimits: v.object({
        maxInputBytes: v.number(),
        maxOutputTokens: v.number(),
        maxTurns: v.literal(1),
        timeoutMs: v.number(),
      }),
    }),
  }),
);

// Keep the browser errand execution contract in the durable schema rather
// than accepting an untyped JSON blob. `approvedSteps` is a snapshot taken at
// the owner decision boundary; legacy unsealed rows intentionally cannot run.
const browserErrandEnvelopeValidator = v.object({
  allowedHosts: v.array(v.string()),
  allowedActions: v.array(v.string()),
  maxSends: v.number(),
  maxSteps: v.number(),
  ttlMs: v.number(),
});

const browserErrandStepValidator = v.union(
  v.object({ action: v.literal("navigate"), url: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("read"), selector: v.optional(v.string()), limit: v.optional(v.number()), label: v.optional(v.string()) }),
  v.object({ action: v.literal("click"), selector: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("type"), selector: v.string(), text: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("select"), selector: v.string(), value: v.string(), label: v.optional(v.string()) }),
  v.object({ action: v.literal("screenshot"), fullPage: v.optional(v.boolean()), label: v.optional(v.string()) }),
  v.object({ action: v.literal("send"), selector: v.string(), label: v.optional(v.string()) }),
);

const missionSupervisorDecisionOriginValidator = v.union(
  v.literal("model"),
  v.literal("policy"),
);

const missionSupervisorControlActionValidator = v.union(
  v.literal("pause"),
  v.literal("resume"),
  v.literal("cancel"),
  v.literal("steer"),
  v.literal("provide_input"),
);

const supervisorFleetManifestMemberValidator = v.object({
  protocolVersion: v.literal(1),
  jobId: v.id("jobs"),
  workAttemptId: v.id("workAttempts"),
  attempt: v.number(),
  phase: v.union(v.literal("specialist"), v.literal("delivery")),
  authorityDigest: v.string(),
  schedulingAdmissionId: v.id("jobSchedulingAdmissions"),
  schedulingBindingDigest: v.string(),
  schedulingGroupKey: v.string(),
  workOrderRevisionId: v.id("workOrderRevisions"),
  workOrderRevision: v.number(),
  workOrderRevisionDigest: v.string(),
  nextRunAt: v.number(),
  priority: v.number(),
  createdAt: v.number(),
  writeLineage: v.optional(v.string()),
  approvalId: v.optional(v.id("approvals")),
  approvalResolvedAt: v.optional(v.number()),
  deliveryAttemptId: v.optional(v.id("deliveryAttempts")),
  deliverySourceWorkAttempt: v.optional(v.number()),
  deliveryGeneration: v.optional(v.number()),
  reviewReceiptId: v.optional(v.id("reviewReceipts")),
  reviewReceiptDigest: v.optional(v.string()),
  memberDigest: v.string(),
});

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
    // Canonical-memory metadata. Source identifiers are opaque message IDs;
    // raw conversation is never duplicated into provenance fields.
    dedupeKey: v.optional(v.string()),
    confidence: v.optional(v.number()),
    sourceMessageIds: v.optional(v.array(v.string())),
    revision: v.optional(v.number()),
    lastConfirmedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_kind", ["kind"])
    .index("by_createdAt", ["createdAt"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_dedupeKey", ["dedupeKey"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] }),

  // A durable page cursor for the Git-backed Obsidian mirror. It advances only
  // after the corresponding page has been committed and pushed by Trigger.
  memoryVaultReconciliations: defineTable({
    key: v.string(),
    cycle: v.number(),
    cutoffAt: v.number(),
    cursor: v.optional(v.string()),
    complete: v.boolean(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Small, superseding facts needed on the very next turn (for example the
  // city Daniel is currently in). Raw chat stays private in chatMessages;
  // this table stores only a bounded value and its provenance receipt.
  currentState: defineTable({
    key: v.string(),
    value: v.string(),
    confidence: v.number(),
    sourceMessageId: v.string(),
    observedAt: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expiry", ["expiresAt"]),

  // Performance counters only: no transcript, source URLs, device fingerprint,
  // or wall-clock activity history is retained with a voice turn.
  voiceTurnMetrics: defineTable({
    turnId: v.string(),
    transcriptSource: v.union(v.literal("browser-final"), v.literal("server")),
    endpointStrategy: v.optional(v.union(v.literal("standard"), v.literal("trusted-browser-final"))),
    researchState: v.union(v.literal("none"), v.literal("ready"), v.literal("discarded"), v.literal("promoted")),
    researchSourceCount: v.number(),
    outcome: v.union(v.literal("queued"), v.literal("audible"), v.literal("failed")),
    captureToSpeechClosedMs: v.optional(v.number()),
    speechClosedToTranscriptMs: v.optional(v.number()),
    transcriptToQueuedMs: v.optional(v.number()),
    queuedToFirstAudioMs: v.optional(v.number()),
    captureToFirstAudioMs: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_turn", ["turnId"])
    .index("by_updatedAt", ["updatedAt"]),

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
    status: v.string(), // "pending" | "streaming" | "done" | "error" | "superseded"
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
    // Foreground turns use a bounded, fenced recovery protocol. `attemptCount`
    // lives on both sides of a turn for inspection, while `claimToken` prevents
    // a timed-out worker from painting or finalizing over its replacement.
    attemptCount: v.optional(v.number()),
    dispatchEpoch: v.optional(v.number()),
    claimToken: v.optional(v.string()),
    lastProgressAt: v.optional(v.number()),
    guestSlotReleased: v.optional(v.boolean()),
    // Cheap presence bits let the worker skip side-table reads for the common
    // text-only turn. Undefined preserves compatibility with older rows.
    hasLinkedFiles: v.optional(v.boolean()),
    hasResearchPrefetch: v.optional(v.boolean()),
    // Persistent media card: everything JARVIS shows also lands in the stream
    // so Daniel can always get back to it later.
    attachment: v.optional(
      v.object({
        type: v.string(),
        value: v.string(),
        title: v.optional(v.string()),
        // Persistent artifacts carry a first-party attachment route so a
        // visual card and its direct-download action never depend on an R2
        // browser header or a temporary third-party URL.
        downloadUrl: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_thread_status", ["threadId", "status", "createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_parent", ["parentMessageId", "createdAt"])
    .index("by_request", ["requestId"]),

  // Short-lived, non-reactive evidence gathered while an owner is still
  // speaking. Keeping this beside (rather than on) chatMessages prevents a
  // few KB of search context from being resent to every browser on each
  // 350 ms assistant-stream update. It is read only by the claimed worker and
  // deleted on every terminal turn path.
  chatTurnPrefetches: defineTable({
    messageId: v.id("chatMessages"),
    threadId: v.string(),
    basis: v.string(),
    context: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_message", ["messageId"])
    .index("by_thread", ["threadId"]),

  // A non-reactive proof that this exact user row was admitted through the
  // authenticated owner conversation. It never stores the browser session or
  // a portable bearer; a short per-call receipt is additionally fenced to the
  // live assistant claim before a foreground owner capability can run.
  chatTurnOwnerToolGrants: defineTable({
    messageId: v.id("chatMessages"),
    threadId: v.string(),
    // The exact direct-command scope is minted at authenticated owner-message
    // admission. Never reconstruct this from conversation/model text later.
    toolNames: v.array(v.string()),
    // Present only when the direct owner command explicitly requested both a
    // iCloud Calendar create and a Jarvis Hub to-do. This capability is
    // consumed by the foreground worker; it is never inferred from model text.
    calendarAndHubTodo: v.optional(v.boolean()),
    // Browser execution needs more than a generic tool name: the exact ID is
    // parsed from the owner’s direct message and is the only errand this grant
    // can redeem. Undefined is retained only for pre-browser legacy grants.
    browserErrandId: v.optional(v.string()),
    issuedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_message", ["messageId"])
    .index("by_thread", ["threadId"]),

  // A redeemed dynamic-call receipt is the irrevocable linearization point for
  // its Gmail/iCloud Calendar request. A later cancellation may stop the
  // reply, but cannot claim an already-committed provider request vanished.
  // Bounded cleanup happens with the owning terminal chat turn.
  chatTurnOwnerToolUses: defineTable({
    receiptKey: v.string(),
    messageId: v.id("chatMessages"),
    assistantId: v.id("chatMessages"),
    callId: v.string(),
    toolName: v.string(),
    // Present only for a browser run. It binds the redeemed one-time
    // foreground receipt to one exact durable errand ID before `claim` will
    // hand any sealed browser steps to the provider.
    browserErrandId: v.optional(v.string()),
    committedAt: v.number(),
  })
    .index("by_receipt", ["receiptKey"])
    .index("by_message", ["messageId"]),

  chatSessions: defineTable({
    threadId: v.string(),
    status: v.string(), // "idle" | "working"
    // Storage-only compatibility for sessions written before the Codex cutover.
    // Active workers no longer read or write this value.
    claudeSessionId: v.optional(v.string()),
    lastActiveAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_status_activity", ["status", "lastActiveAt"]),

  chatGuestLimits: defineTable({
    guestId: v.string(),
    tokens: v.number(),
    refilledAt: v.number(),
    day: v.string(),
    dailyCount: v.number(),
    inFlight: v.number(),
  }).index("by_guest", ["guestId"]),

  // Private user-provided source files. Original and derived bytes live in the
  // non-public `jarvis-private-files` R2 bucket; Convex owns only durable,
  // reactive metadata and bounded extracted chunks. This is deliberately
  // separate from `creations`, whose historical URLs may be public.
  files: defineTable({
    originalName: v.string(),
    relativePath: v.string(),
    mimeType: v.string(),
    detectedMimeType: v.optional(v.string()),
    sizeBytes: v.number(),
    expectedSha256: v.string(),
    sha256: v.optional(v.string()),
    uploadEtag: v.optional(v.string()),
    uploadClaimToken: v.optional(v.string()),
    uploadClaimExpiresAt: v.optional(v.number()),
    cancelRequestedAt: v.optional(v.number()),
    r2Key: v.string(),
    extractedTextR2Key: v.optional(v.string()),
    previewR2Key: v.optional(v.string()),
    status: v.string(), // reserved | uploading | uploaded | processing | ready | stored_only | quarantined | error | deleting | deleted
    ingestVersion: v.number(),
    ingestAttempt: v.number(),
    ingestClaimToken: v.optional(v.string()),
    lastProgressAt: v.optional(v.number()),
    summary: v.optional(v.string()),
    searchText: v.string(),
    extractedChars: v.optional(v.number()),
    chunkCount: v.optional(v.number()),
    pageCount: v.optional(v.number()),
    sheetNames: v.optional(v.array(v.string())),
    errorCode: v.optional(v.string()),
    libraryVisible: v.optional(v.boolean()),
    // A reversible owner review marker. It intentionally does not affect the
    // private R2 object or a file's thread/message provenance.
    reviewState: v.optional(v.union(
      v.literal("unreviewed"),
      v.literal("favorite"),
      v.literal("review_remove"),
    )),
    // Owner-managed workspace metadata. R2 object identities stay immutable;
    // moving or renaming a file changes only this visible hierarchy.
    tags: v.optional(v.array(v.string())),
    deletePreviousStatus: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status_updated", ["status", "updatedAt"])
    .index("by_library_updated", ["libraryVisible", "updatedAt"])
    .index("by_library_review_updated", ["libraryVisible", "reviewState", "updatedAt"])
    .index("by_sha256", ["sha256"])
    .index("by_updatedAt", ["updatedAt"])
    .searchIndex("search_metadata", { searchField: "searchText", filterFields: ["status", "libraryVisible", "reviewState"] }),

  // Editable text/markdown is versioned separately from immutable uploaded
  // bytes and extracted chunks. Existing chunk ids remain stable for saved
  // citations while Jarvis and the workspace can prefer the current draft.
  fileDocuments: defineTable({
    fileId: v.id("files"),
    content: v.string(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_file", ["fileId"])
    .searchIndex("search_content", { searchField: "content" }),

  // One browser reservation covers a bounded multi-file or folder upload.
  // requestId and its returned fileIds make retries idempotent before any R2
  // bytes are accepted.
  uploadBatches: defineTable({
    requestId: v.string(),
    threadId: v.string(),
    status: v.string(), // reserved | uploading | complete | expired | cancelled
    fileIds: v.array(v.id("files")),
    fileCount: v.number(),
    totalBytes: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_request", ["requestId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_expiry", ["status", "expiresAt"]),

  // A file is reusable across chats without duplicating R2 bytes. Removing it
  // from one chat deletes this link, not the globally durable source file.
  threadFiles: defineTable({
    threadId: v.string(),
    fileId: v.id("files"),
    pinned: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread_file", ["threadId", "fileId"])
    .index("by_thread_updated", ["threadId", "updatedAt"])
    .index("by_file", ["fileId", "threadId"]),

  // Immutable turn provenance. Assistant media cards continue to use the
  // legacy singular `chatMessages.attachment`; user files use this join.
  messageFiles: defineTable({
    messageId: v.id("chatMessages"),
    threadId: v.string(),
    fileId: v.id("files"),
    position: v.number(),
    createdAt: v.number(),
  })
    .index("by_message", ["messageId", "position"])
    .index("by_message_file", ["messageId", "fileId"])
    .index("by_thread_created", ["threadId", "createdAt"])
    .index("by_file", ["fileId", "createdAt"]),

  // A short-lived, worker-only source fence. It is created only after the
  // exact claimed user/assistant pair is still streaming and its attached
  // source file is ready. Deletion leaves the row durable but must defer byte
  // cleanup until this lease is released or expires, so a source cannot flip
  // state between final validation and foreground model admission.
  chatTurnFileLeases: defineTable({
    fileId: v.id("files"),
    threadId: v.string(),
    messageId: v.id("chatMessages"),
    assistantId: v.id("chatMessages"),
    claimToken: v.string(),
    leaseId: v.string(),
    sourceKey: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_file_expiry", ["fileId", "expiresAt"])
    .index("by_assistant_claim_lease", ["assistantId", "claimToken", "leaseId"]),

  // Small search documents keep prompt retrieval bounded. Full deterministic
  // extraction remains in private R2 and is never placed in a chat row.
  fileChunks: defineTable({
    fileId: v.id("files"),
    fileKey: v.string(),
    ordinal: v.number(),
    text: v.string(),
    page: v.optional(v.number()),
    sheet: v.optional(v.string()),
    cellRange: v.optional(v.string()),
    chars: v.number(),
    createdAt: v.number(),
  })
    .index("by_file_ordinal", ["fileId", "ordinal"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["fileKey"] }),

  // Stable citations let maps/charts/boards show where a value came from and
  // prevent permanent deletion while a saved creation still depends on it.
  creationFileRefs: defineTable({
    creationId: v.id("creations"),
    fileId: v.id("files"),
    chunkId: v.optional(v.id("fileChunks")),
    blockId: v.optional(v.string()),
    nodeId: v.optional(v.string()),
    role: v.string(),
    createdAt: v.number(),
  })
    .index("by_creation", ["creationId", "createdAt"])
    .index("by_creation_file", ["creationId", "fileId"])
    .index("by_file", ["fileId", "createdAt"]),

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
    // Hunts that never find their price should stop on their own rather than
    // run forever. Absent = open-ended, which keeps every pre-existing watch
    // behaving exactly as before.
    expiresAt: v.optional(v.number()),
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
    /** Opaque server-derived identity for retry-safe automated reminders. */
    sourceKey: v.optional(v.string()),
    originThreadId: v.optional(v.string()),
    deliverStartedAt: v.optional(v.number()),
    deliveryAttempts: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status", "at"])
    .index("by_status_deliverStartedAt", ["status", "deliverStartedAt"])
    .index("by_sourceKey", ["sourceKey"]),

  // Explicit owner-created saved-trip preflights. This is intentionally not a
  // trip-library index: the worker may refresh only rows Daniel has opted into,
  // never every itinerary or every Gmail booking.
  appleMapsOfflinePreflights: defineTable({
    creationId: v.id("creations"),
    sourceKey: v.string(),
    preflight: v.object({
      city: v.string(),
      flightMarker: v.string(),
      flightTitle: v.string(),
      flightStart: v.number(),
      at: v.number(),
      timeZone: v.string(),
      mapUrl: v.string(),
      todoText: v.string(),
      reminderText: v.string(),
    }),
    flightIdentity: v.object({
      selectionId: v.string(),
      messageId: v.string(),
      marker: v.string(),
      threadId: v.optional(v.string()),
      kind: v.string(),
      provider: v.string(),
      confirmationCode: v.optional(v.string()),
    }),
    cityProofIdentity: v.object({
      selectionId: v.string(),
      messageId: v.string(),
      marker: v.string(),
      threadId: v.optional(v.string()),
      kind: v.string(),
      provider: v.string(),
      confirmationCode: v.optional(v.string()),
    }),
    cityProof: v.object({
      city: v.string(),
      title: v.string(),
      bookingName: v.optional(v.string()),
      location: v.string(),
      start: v.number(),
      end: v.number(),
      timeZone: v.optional(v.string()),
      lat: v.number(),
      lng: v.number(),
      distanceKm: v.number(),
      verifiedAt: v.number(),
    }),
    // Additive migration: historical rows simply have no iCloud binding and
    // receive their first one only through a fresh owner-approved preflight.
    // Never infer a managed event from generic CalDAV history.
    iCloudCalendarEvent: v.optional(v.object({
      calendarUrl: v.string(),
      eventUrl: v.string(),
      etag: v.string(),
      revision: v.number(),
      nonce: v.string(),
      committedAt: v.number(),
    })),
    // A CalDAV PUT and a Convex transaction cannot share one atomic commit.
    // Keep the exact owner-approved attempt durable across that boundary so a
    // stale TripDoc revision or lost response can be reconciled safely rather
    // than turning the deterministic resource into an orphan.
    iCloudCalendarAttempt: v.optional(v.object({
      sourceKey: v.string(),
      calendarUrl: v.string(),
      eventUrl: v.string(),
      revision: v.number(),
      nonce: v.string(),
      action: v.union(v.literal("create"), v.literal("update")),
      expectedEtag: v.optional(v.string()),
      observedEtag: v.optional(v.string()),
      observedAt: v.optional(v.number()),
      missingAt: v.optional(v.number()),
      recovery: v.optional(v.object({
        revision: v.number(),
        nonce: v.string(),
        etag: v.string(),
      })),
      startedAt: v.number(),
    })),
    refreshState: v.union(
      v.literal("scheduled"),
      v.literal("pending_refresh"),
      v.literal("pending_google"),
      v.literal("needs_flight_confirmation"),
      v.literal("needs_city_confirmation"),
      v.literal("too_late"),
      v.literal("trip_missing"),
    ),
    lastError: v.optional(v.string()),
    lastCheckedAt: v.optional(v.number()),
    nextRefreshAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_creationId", ["creationId"])
    .index("by_nextRefreshAt", ["nextRefreshAt"])
    .index("by_refreshState_nextRefreshAt", ["refreshState", "nextRefreshAt"]),

  jobs: defineTable({
    admissionProtocolVersion: v.optional(v.number()),
    protocolHoldReason: v.optional(v.string()),
    repo: v.optional(v.string()),
    task: v.string(),
    policyTask: v.optional(v.string()),
    status: v.string(), // pending | dispatching | running | done | error
    result: v.optional(v.string()),
    readonly: v.optional(v.boolean()), // if true, runner never commits/pushes
    model: v.optional(v.string()), // optional Codex tier override (luna|terra|sol)
    reasoningEffort: v.optional(v.string()), // optional per-job override (low|medium|high|max)
    backgroundExecutionProfile: v.optional(backgroundExecutionProfileValidator),
    mcp: v.optional(v.array(v.string())), // MCP servers to attach (playwright, context7)
    toolScope: v.optional(v.array(v.string())),
    agentRole: v.optional(v.string()),
    machineClass: v.optional(v.string()),
    triggerMachinePreset: v.optional(v.string()),
    triggerMachineReason: v.optional(v.string()),
    triggerObservedMachinePreset: v.optional(v.string()),
    triggerObservedMachineReason: v.optional(v.string()),
    triggerPlatformAttempt: v.optional(v.number()),
    incidentId: v.optional(v.string()), // set on self-repair jobs → resolves the incident on success
    retried: v.optional(v.boolean()), // failed once already — no second retry
    missionId: v.optional(v.string()), // part of an orchestrated fleet
    // Additive provenance only. Future supervisor mutations bind each admitted
    // job to the exact epoch and immutable decision receipt that created it.
    supervisorEpoch: v.optional(v.number()),
    supervisorDecisionKey: v.optional(v.string()),
    supervisorJobOrdinal: v.optional(v.number()),
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
    dispatchGeneration: v.optional(v.number()),
    dispatchPhase: v.optional(v.string()),
    dispatchReceiptId: v.optional(v.id("dispatchReceipts")),
    dispatchReceiptDigest: v.optional(v.string()),
    dispatchPayloadDigest: v.optional(v.string()),
    // Snapshot produced by the claim transaction. Exact redelivery returns
    // this immutable envelope rather than re-reading changing upstream work.
    upstreamEvidence: v.optional(v.array(v.object({
      label: v.string(), status: v.string(), result: v.string(), verificationNote: v.string(),
      planDigest: v.optional(v.string()), planGeneration: v.optional(v.number()),
      sourceNodeId: v.optional(v.string()), sourceJobId: v.optional(v.string()),
      sourceAttempt: v.optional(v.number()), sourceSteerRevision: v.optional(v.number()),
      workOrderRevisionDigest: v.optional(v.string()),
      reviewReceiptDigest: v.optional(v.string()), integrationReceiptDigest: v.optional(v.string()),
      repository: v.optional(v.string()), sourceBranch: v.optional(v.string()), sourceHeadSha: v.optional(v.string()),
      integrationBranch: v.optional(v.string()), integrationHeadSha: v.optional(v.string()),
      artifactRefs: v.optional(v.array(v.string())), resultDigest: v.optional(v.string()),
      handoffPayloadDigest: v.optional(v.string()),
    }))),
    dispatchLeaseUntil: v.optional(v.number()),
    dispatchReason: v.optional(v.string()),
    workerRunId: v.optional(v.string()),
    // New Trigger claims opt into the exact heartbeat fence. Keep this
    // optional for a short rolling-deploy handoff so an already-running
    // legacy worker cannot be reaped merely because it predates the field.
    heartbeatProtocolVersion: v.optional(v.literal(2)),
    workerRuntime: v.optional(v.string()),
    providerRunState: v.optional(v.string()),
    providerObservedAt: v.optional(v.number()),
    // Exact reason for a system-held cloud setup pause. It is deliberately
    // separate from human-readable progress so bounded cleanup never parses
    // broad failure text.
    cloudWorkspaceBlockCode: v.optional(v.string()),
    // Machine-readable terminal controller-session hold. This only records a
    // known-safe, finite error code; session credentials never enter Convex.
    controllerSessionHoldCode: v.optional(v.string()),
    controllerSessionRepairRequired: v.optional(v.boolean()),
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
    // Immutable scheduler admission. missionGroupId is the top-level request;
    // projectGroupId is its executable repository/evidence child. The group
    // key also includes projectRepository and is never derived from a label,
    // UI selection, branch, or latest pointer during dispatch.
    missionGroupId: v.optional(v.string()),
    projectGroupId: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    projectRepository: v.optional(v.string()),
    schedulingGroupKey: v.optional(v.string()),
    schedulingProtocolVersion: v.optional(v.number()),
    schedulingAdmissionId: v.optional(v.id("jobSchedulingAdmissions")),
    schedulingBindingDigest: v.optional(v.string()),
    schedulingBound: v.optional(v.boolean()),
    workOrderProtocolVersion: v.optional(v.number()),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevisionDigest: v.optional(v.string()),
    pendingWorkOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    pendingWorkOrderRevisionDigest: v.optional(v.string()),
    // False keeps dependency-blocked and historical unbound work out of the
    // hot due index; completion/migration explicitly promotes it.
    dispatchReady: v.optional(v.boolean()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    modelReason: v.optional(v.string()),
    // Immutable work-item isolation identities. `branch` remains the legacy
    // display/transport alias for workerBranch during the rollout.
    sourceProvider: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    sourceObservedAt: v.optional(v.number()),
    sourceAdmissionDigest: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    workerLineage: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    integrationLineage: v.optional(v.string()),
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
    .index("by_visibility_status", ["visibility", "status", "createdAt"])
    .index("by_status_provider_observed", ["status", "providerRunState", "providerObservedAt"]),

  // Compact control-plane read model. Live subscriptions, scheduler polls and
  // execution lease checks use this table instead of materialising the much
  // larger durable jobs (task/result/checkpoint/transcript). Durable state
  // transitions still commit to jobs and update this projection atomically.
  jobRuntime: defineTable({
    jobId: v.id("jobs"),
    admissionProtocolVersion: v.optional(v.number()),
    protocolHoldReason: v.optional(v.string()),
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
    agentRole: v.optional(v.string()),
    machineClass: v.optional(v.string()),
    triggerMachinePreset: v.optional(v.string()),
    triggerMachineReason: v.optional(v.string()),
    triggerObservedMachinePreset: v.optional(v.string()),
    triggerObservedMachineReason: v.optional(v.string()),
    triggerPlatformAttempt: v.optional(v.number()),
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
    // True only while a paused specialist still owns the one claimed dispatch
    // allowed to submit a final checkpoint. This prevents ordinary paused
    // history from starving the bounded liveness reconciler.
    pauseCheckpointPending: v.optional(v.boolean()),
    attempt: v.number(),
    maxAttempts: v.number(),
    heartbeatAt: v.number(),
    nextRunAt: v.optional(v.number()),
    dispatchId: v.optional(v.string()),
    dispatchGeneration: v.optional(v.number()),
    dispatchPhase: v.optional(v.string()),
    dispatchReceiptId: v.optional(v.id("dispatchReceipts")),
    dispatchReceiptDigest: v.optional(v.string()),
    dispatchPayloadDigest: v.optional(v.string()),
    dispatchLeaseUntil: v.optional(v.number()),
    workerRunId: v.optional(v.string()),
    workerRuntime: v.optional(v.string()),
    providerRunState: v.optional(v.string()),
    providerObservedAt: v.optional(v.number()),
    cloudWorkspaceBlockCode: v.optional(v.string()),
    controllerSessionHoldCode: v.optional(v.string()),
    controllerSessionRepairRequired: v.optional(v.boolean()),
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
    missionGroupId: v.optional(v.string()),
    projectGroupId: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    projectRepository: v.optional(v.string()),
    schedulingGroupKey: v.optional(v.string()),
    schedulingProtocolVersion: v.optional(v.number()),
    schedulingAdmissionId: v.optional(v.id("jobSchedulingAdmissions")),
    schedulingBindingDigest: v.optional(v.string()),
    schedulingBound: v.optional(v.boolean()),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    dispatchReady: v.optional(v.boolean()),
    sourceProvider: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    sourceObservedAt: v.optional(v.number()),
    sourceAdmissionDigest: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    workerLineage: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    integrationLineage: v.optional(v.string()),
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
    .index("by_dispatch_ready", ["status", "schedulingBound", "dispatchReady", "nextRunAt", "createdAt"])
    .index("by_group_dispatch_ready", ["schedulingGroupKey", "status", "schedulingBound", "dispatchReady", "nextRunAt", "createdAt"])
    .index("by_status_scheduling_bound", ["status", "schedulingBound", "priority", "createdAt"])
    .index("by_status_heartbeat", ["status", "heartbeatAt"])
    .index("by_pause_checkpoint_heartbeat", [
      "status",
      "pauseCheckpointPending",
      "heartbeatAt",
    ])
    .index("by_status_progress", ["status", "progressAt"])
    .index("by_status_dispatch_lease", ["status", "dispatchLeaseUntil"])
    .index("by_controller_session_repair", ["controllerSessionRepairRequired", "status", "updatedAt"])
    .index("by_active_priority", ["active", "priority", "createdAt"])
    .index("by_visibility_status_priority", ["visibility", "status", "priority", "createdAt"])
    .index("by_thread_visibility_status_priority", ["originThreadId", "visibility", "status", "priority", "createdAt"])
    .index("by_thread_visibility_active_priority", ["originThreadId", "visibility", "active", "priority", "createdAt"])
    // Powers the main (non-embedded) page's fleet-wide command center: every
    // active conversation-visibility job across every thread, not just the
    // one currently active thread. See convex/commandCenter.ts:fleetSnapshot.
    .index("by_visibility_active_priority", ["visibility", "active", "priority", "createdAt"])
    .index("by_plan_parent_generation_node", ["planParentMissionId", "planGeneration", "planNodeId"])
    .index("by_mission", ["missionId", "createdAt"])
    .index("by_mission_active_priority", [
      "missionId",
      "active",
      "priority",
      "createdAt",
    ]),

  // Durable fair-queue state for one immutable executable project group.
  // Rows are admitted atomically with jobs and survive worker/controller
  // retries; the scheduler never treats a mutable "latest" row as authority.
  workGroupScheduling: defineTable({
    groupKey: v.string(),
    missionGroupId: v.string(),
    projectGroupId: v.string(),
    canonicalProjectId: v.optional(v.string()),
    projectRepository: v.optional(v.string()),
    // One indexed queue head per immutable group replaces sampling arbitrary
    // ends of the global jobs index. `queueEligible` is a durable time cursor:
    // future heads become eligible in bounded due pages, and reservations
    // move the group behind every not-yet-served peer.
    queueHeadJobId: v.optional(v.id("jobs")),
    queueHeadNextRunAt: v.optional(v.number()),
    queueEligible: v.optional(v.boolean()),
    lastServedSequence: v.number(),
    reservationCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_group", ["groupKey"])
    .index("by_queue_due", ["queueEligible", "queueHeadNextRunAt", "groupKey"])
    .index("by_queue_service", ["queueEligible", "lastServedSequence", "groupKey"]),

  // Per-job immutable admission prevents a wholesale rewrite of the mutable
  // job document from moving work to another mission or repository group.
  jobSchedulingAdmissions: defineTable({
    jobId: v.id("jobs"),
    protocolVersion: v.optional(v.number()),
    missionGroupId: v.string(),
    projectGroupId: v.string(),
    canonicalProjectId: v.optional(v.string()),
    projectRepository: v.optional(v.string()),
    schedulingGroupKey: v.string(),
    readonly: v.optional(v.boolean()),
    sourceProvider: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    sourceObservedAt: v.optional(v.number()),
    sourceAdmissionDigest: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    workerLineage: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    integrationLineage: v.optional(v.string()),
    bindingDigest: v.optional(v.string()),
    initialWorkOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    initialWorkOrderRevisionDigest: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_group", ["schedulingGroupKey", "jobId"]),

  // Append-only executable authority. Mutable progress, logs, results,
  // checkpoints and provider observations are deliberately excluded.
  workOrderRevisions: defineTable({
    protocolVersion: v.number(),
    jobId: v.id("jobs"),
    revision: v.number(),
    parentRevisionId: v.optional(v.id("workOrderRevisions")),
    parentRevisionDigest: v.optional(v.string()),
    executableTask: v.string(),
    policyTask: v.string(),
    steeringInstruction: v.optional(v.string()),
    acceptanceCriteria: v.array(v.string()),
    schedulingBindingDigest: v.string(),
    canonicalProjectId: v.string(),
    repository: v.optional(v.string()),
    sourceProvider: v.string(),
    sourceBranch: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    sourceObservedAt: v.number(),
    sourceAdmissionDigest: v.string(),
    readonly: v.boolean(),
    toolScope: v.array(v.string()),
    mcpScope: v.array(v.string()),
    deliveryPolicy: v.string(),
    risk: v.string(),
    approvalRequired: v.boolean(),
    approvalReason: v.optional(v.string()),
    approvalResult: v.string(),
    agentId: v.string(),
    agentRole: v.string(),
    minimumModel: v.string(),
    minimumReasoningEffort: v.string(),
    // Optional only for active protocol-v2 rows created before the execution
    // profile existed. New work orders must carry the hashed snapshot.
    backgroundExecutionProfile: v.optional(backgroundExecutionProfileValidator),
    machineClass: v.string(),
    // Optional only for Convex-first rollout compatibility. Protocol-v2
    // readers reject historical rows that do not carry both exact bindings.
    triggerMachinePreset: v.optional(v.string()),
    triggerMachineReason: v.optional(v.string()),
    revisionDigest: v.string(),
    createdAt: v.number(),
  })
    .index("by_job_revision", ["jobId", "revision"])
    .index("by_job_digest", ["jobId", "revisionDigest"]),

  // One optimistic-concurrency fence allocates monotonically increasing fair
  // service tickets across every background mission/project group.
  dispatchSchedulerState: defineTable({
    key: v.string(),
    nextSequence: v.number(),
    lastGroupKey: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Orchestrated agent fleets: one mission = a decomposed goal running as
  // parallel jobs; when the last one lands, a synthesis pass merges the
  // results into ONE coherent report back to Daniel.
  missions: defineTable({
    admissionProtocolVersion: v.optional(v.number()),
    protocolHoldReason: v.optional(v.string()),
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
    materializationStatus: v.optional(v.string()),
    materializationCursor: v.optional(v.number()),
    materializationWaitingApprovals: v.optional(v.number()),
    materializationCompletedAt: v.optional(v.number()),
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
    projectAdmissions: v.optional(v.array(projectSourceAdmission)),
    canonicalProjectId: v.optional(v.string()),
    sourceProvider: v.optional(v.string()),
    sourceRef: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    sourceObservedAt: v.optional(v.number()),
    sourceAdmissionDigest: v.optional(v.string()),
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
    integrationObservedAt: v.optional(v.number()),
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
    admissionProtocolVersion: v.optional(v.number()),
    protocolHoldReason: v.optional(v.string()),
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
    canonicalProjectId: v.optional(v.string()),
    revisionWave: v.number(),
    maxRevisionWaves: v.number(),
    maxBuildSessions: v.number(),
    planningJobId: v.optional(v.string()),
    validatorJobId: v.optional(v.string()),
    planDigest: v.optional(v.string()),
    planGeneration: v.optional(v.number()),
    planNodeCount: v.optional(v.number()),
    materializationStatus: v.optional(v.string()),
    materializationCursor: v.optional(v.number()),
    materializationWaitingApprovals: v.optional(v.number()),
    materializationCompletedAt: v.optional(v.number()),
    sourceBranch: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    integrationHeadSha: v.optional(v.string()),
    integrationObservedAt: v.optional(v.number()),
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

  // Compact, authoritative scheduler state for a future re-entrant Mastra
  // supervisor. Convex owns every lease/revision fence; model calls remain
  // stateless workers operating on one bounded snapshot at a time.
  missionSupervisorState: defineTable({
    protocolVersion: v.literal(1),
    missionId: v.id("missions"),
    requestKey: v.string(),
    requestDigest: v.string(),
    requestPayloadJson: v.string(),
    idempotencyDigest: v.optional(v.string()),
    state: missionSupervisorStateValidator,
    epoch: v.number(),
    nextDecisionSequence: v.number(),
    inputRevision: v.number(),
    handledInputRevision: v.number(),
    dirtyJobIds: v.array(v.id("jobs")),
    nextTickAt: v.optional(v.number()),
    leaseOwner: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseVersion: v.number(),
    leaseHeartbeatAt: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    lastSnapshotDigest: v.optional(v.string()),
    lastDecisionKey: v.optional(v.string()),
    lastDecisionDigest: v.optional(v.string()),
    lastDecisionAt: v.optional(v.number()),
    totalJobs: v.number(),
    // Optional during rolling backfill. New supervisor writes maintain this
    // exact counter so command-center reads never infer active controls from
    // historical terminal rows included in totalJobs.
    nonterminalJobCount: v.optional(v.number()),
    // Rollout-safe capability advertisement. Protocol 1 intentionally
    // supports only atomic pause/resume; cancel and steer stay hidden until
    // their own full-ledger transactions exist.
    activeJobControlProtocolVersion: v.optional(v.literal(1)),
    activeJobControlActions: v.optional(v.array(v.union(
      v.literal("pause"),
      v.literal("resume"),
    ))),
    // The active pause cohort is one immutable control receipt, not every job
    // that happens to be paused when a later resume arrives.
    pauseCohortProtocolVersion: v.optional(v.literal(1)),
    pauseCohortControlReceiptId: v.optional(
      v.id("missionSupervisorControls"),
    ),
    pauseCohortInputRevision: v.optional(v.number()),
    pauseCohortJobCount: v.optional(v.number()),
    pauseCohortDigest: v.optional(v.string()),
    maxJobs: v.number(),
    decisionCount: v.number(),
    maxDecisions: v.number(),
    deadlineAt: v.number(),
    consecutiveFailures: v.number(),
    lastErrorCode: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_mission", ["missionId"])
    .index("by_request", ["requestKey"])
    .index("by_state_due", ["state", "nextTickAt"])
    .index("by_state_lease", ["state", "leaseUntil"]),

  // One atomically maintained command-center row per supervised mission.
  // The UI reads this compact projection by thread and never discovers
  // supervisor state through global scheduler indexes or mission N+1 reads.
  missionSupervisorCommand: defineTable({
    protocolVersion: v.literal(1),
    missionId: v.id("missions"),
    originThreadId: v.string(),
    active: v.boolean(),
    priority: v.number(),
    goal: v.string(),
    mode: v.literal("supervised"),
    status: v.string(),
    phase: v.string(),
    percent: v.number(),
    primaryRepo: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    state: missionSupervisorStateValidator,
    inputRevision: v.number(),
    steerRevision: v.number(),
    deadlineAt: v.number(),
    totalJobs: v.number(),
    nonterminalJobCount: v.optional(v.number()),
    activeJobControlProtocolVersion: v.optional(v.literal(1)),
    activeJobControlActions: v.optional(v.array(v.union(
      v.literal("pause"),
      v.literal("resume"),
    ))),
    controlAffordanceProtocolVersion: v.optional(v.literal(1)),
    supportedControlActions: v.optional(v.array(v.union(
      v.literal("pause"),
      v.literal("resume"),
      v.literal("cancel"),
      v.literal("steer"),
      v.literal("provide_input"),
    ))),
    pauseCohortProtocolVersion: v.optional(v.literal(1)),
    pauseCohortJobCount: v.optional(v.number()),
    inputTargeted: v.boolean(),
    nextTickAt: v.optional(v.number()),
    leaseUntil: v.optional(v.number()),
    question: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_mission", ["missionId"])
    .index("by_thread_active_priority", [
      "originThreadId",
      "active",
      "priority",
      "updatedAt",
    ]),

  // Append-only model decision receipts. A future commit mutation checks this
  // ledger before its live lease so a lost response can replay the exact prior
  // result without creating duplicate jobs, attention items, or chat delivery.
  missionSupervisorDecisions: defineTable({
    protocolVersion: v.literal(1),
    missionId: v.id("missions"),
    epoch: v.number(),
    sequence: v.number(),
    decisionKey: v.string(),
    observedInputRevision: v.number(),
    snapshotDigest: v.string(),
    kind: missionSupervisorDecisionKindValidator,
    payloadJson: v.string(),
    payloadDigest: v.string(),
    rationale: v.string(),
    decisionOrigin: missionSupervisorDecisionOriginValidator,
    modelProvider: v.union(
      v.literal("codex-subscription"),
      v.literal("deterministic-policy"),
    ),
    modelTier: missionSupervisorModelTierValidator,
    modelId: v.string(),
    reasoningEffort: v.string(),
    tierReason: v.string(),
    supervisorPromptVersion: v.string(),
    leaseVersion: v.number(),
    triggerRunId: v.string(),
    deploymentVersion: v.optional(v.string()),
    createdJobIds: v.array(v.id("jobs")),
    supersessionIds: v.optional(v.array(v.id("missionSupervisorSupersessions"))),
    inputTargetJobId: v.optional(v.id("jobs")),
    inputTargetReceiptDigest: v.optional(v.string()),
    attentionItemId: v.optional(v.id("attentionItems")),
    chatMessageIds: v.array(v.id("chatMessages")),
    resultState: v.string(),
    nextTickAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["decisionKey"])
    .index("by_mission_epoch_sequence", ["missionId", "epoch", "sequence"]),

  // Immutable user-control receipts make retries safe even after later
  // supervisor progress. Rejections are receipts too: a stale request key can
  // never become applicable merely because the mission changes afterwards.
  missionSupervisorControls: defineTable({
    protocolVersion: v.literal(1),
    missionId: v.id("missions"),
    requestKey: v.string(),
    requestDigest: v.string(),
    action: missionSupervisorControlActionValidator,
    expectedInputRevision: v.number(),
    inputDigest: v.optional(v.string()),
    applied: v.boolean(),
    noop: v.boolean(),
    reason: v.string(),
    scope: v.string(),
    resultState: v.optional(missionSupervisorStateValidator),
    resultInputRevision: v.optional(v.number()),
    batchProtocolVersion: v.optional(v.literal(1)),
    affectedJobIds: v.optional(v.array(v.id("jobs"))),
    affectedJobCount: v.optional(v.number()),
    batchDigest: v.optional(v.string()),
    sourcePauseControlReceiptId: v.optional(
      v.id("missionSupervisorControls"),
    ),
    // A resume receipt seals only the exact post-transition members that were
    // immediately executable. The server uses this immutable scope for one
    // targeted fleet offer; browsers never receive these private pointers.
    fleetManifestProtocolVersion: v.optional(v.literal(1)),
    fleetManifest: v.optional(v.array(
      supervisorFleetManifestMemberValidator,
    )),
    fleetManifestCount: v.optional(v.number()),
    fleetManifestDigest: v.optional(v.string()),
    wakeRequested: v.boolean(),
    ticketLeaseVersion: v.optional(v.number()),
    ticketEpoch: v.optional(v.number()),
    ticketDecisionSequence: v.optional(v.number()),
    ticketInputRevision: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["requestKey"])
    .index("by_mission_created", ["missionId", "createdAt"]),

  // Append-only recovery lineage. A terminal supervisor job is never revived
  // in place: one exact receipt-bound leaf may point to exactly one freshly
  // admitted successor, with generation and autonomous-recovery counts derived
  // from the preceding ledger rather than supplied by a caller.
  missionSupervisorSupersessions: defineTable({
    protocolVersion: v.literal(1),
    supersessionKey: v.string(),
    supersessionDigest: v.string(),
    missionId: v.id("missions"),
    decisionKey: v.string(),
    decisionOrdinal: v.number(),
    mode: v.union(
      v.literal("retry"),
      v.literal("remediate"),
      v.literal("input_revision"),
    ),
    rootJobId: v.id("jobs"),
    generation: v.number(),
    autonomousRecoveryCount: v.number(),
    predecessorJobId: v.id("jobs"),
    predecessorAttempt: v.number(),
    predecessorReceiptId: v.id("workReceipts"),
    predecessorReceiptDigest: v.string(),
    successorJobId: v.id("jobs"),
    successorSchedulingBindingDigest: v.string(),
    successorWorkOrderRevisionId: v.id("workOrderRevisions"),
    successorWorkOrderRevisionDigest: v.string(),
    successorCanonicalProjectId: v.string(),
    successorRepository: v.optional(v.string()),
    successorSourceAdmissionDigest: v.string(),
    observedInputRevision: v.number(),
    inputControlReceiptId: v.optional(v.id("missionSupervisorControls")),
    inputControlRequestDigest: v.optional(v.string()),
    inputControlDigest: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_key", ["supersessionKey"])
    .index("by_mission_created", ["missionId", "createdAt"])
    .index("by_predecessor", ["predecessorJobId"])
    .index("by_successor", ["successorJobId"])
    .index("by_root_generation", ["rootJobId", "generation"]),

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

  // A one-way deployment cutover for worker heartbeat fencing. The first V2
  // Trigger worker records availability before it claims work; versionless
  // workers that were already running get only their bounded drain window.
  workerProtocolRollouts: defineTable({
    key: v.string(),
    protocolVersion: v.literal(2),
    activatedAt: v.number(),
    activatedByDeploymentVersion: v.optional(v.string()),
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
    // Old auto-minted rows have no enrollment receipt and are intentionally
    // invalid. New rows are created only through the fail-closed route gate.
    enrolledAt: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_expiry", ["expiresAt"]),

  // One-time owner pairing capabilities. Only a trusted worker can create a
  // ticket; possession of the high-entropy plaintext ticket can consume it
  // exactly once to enroll Daniel's browser. The plaintext is never stored.
  ownerPairingTickets: defineTable({
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_token", ["tokenHash"])
    .index("by_expiry", ["expiresAt"]),

  // Revocable owner-control capabilities for an explicitly trusted embedded
  // host. They avoid third-party cookies without ever promoting the read-only
  // Convex viewer JWT into a control credential.
  embedControlSessions: defineTable({
    tokenHash: v.string(),
    adminTokenHash: v.string(),
    hostOrigin: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["tokenHash"])
    .index("by_admin", ["adminTokenHash"])
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
    authorityDigest: v.optional(v.string()),
    schedulingBindingDigest: v.optional(v.string()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    repository: v.optional(v.string()),
    missionGroupId: v.optional(v.string()),
    projectGroupId: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    sourceAdmissionDigest: v.optional(v.string()),
    workspaceLineage: v.optional(v.string()),
    workerLineage: v.optional(v.string()),
    workerBranch: v.optional(v.string()),
    retryLineage: v.optional(v.string()),
    integrationLineage: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    workerRunId: v.optional(v.string()),
    // Mirrors the job-level immutable claim protocol for audit and replay.
    heartbeatProtocolVersion: v.optional(v.literal(2)),
    dispatchId: v.optional(v.string()),
    dispatchGeneration: v.optional(v.number()),
    dispatchPhase: v.optional(v.string()),
    dispatchReceiptId: v.optional(v.id("dispatchReceipts")),
    dispatchReceiptDigest: v.optional(v.string()),
    dispatchPayloadDigest: v.optional(v.string()),
    triggerMachinePreset: v.optional(v.string()),
    triggerMachineReason: v.optional(v.string()),
    triggerObservedMachinePreset: v.optional(v.string()),
    triggerObservedMachineReason: v.optional(v.string()),
    triggerPlatformAttempt: v.optional(v.number()),
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
      workOrderRevisionDigest: v.optional(v.string()),
      reviewReceiptDigest: v.optional(v.string()), integrationReceiptDigest: v.optional(v.string()),
      repository: v.optional(v.string()), sourceBranch: v.optional(v.string()), sourceHeadSha: v.optional(v.string()),
      integrationBranch: v.optional(v.string()), integrationHeadSha: v.optional(v.string()),
      artifactRefs: v.optional(v.array(v.string())), resultDigest: v.optional(v.string()),
      handoffPayloadDigest: v.optional(v.string()),
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
    // No auth material is stored here. This is a replay-safety receipt for
    // the exact Codex turn boundary and first external tool effect.
    codexTurnReceiptId: v.optional(v.string()),
    codexTurnReceiptSequence: v.optional(v.number()),
    codexTurnReceiptPhase: v.optional(v.string()),
    codexTurnReceiptAt: v.optional(v.number()),
    // This write-once marker is the replay lookup authority. It is set in
    // the same mutation as the complete immutable receipt so replay never
    // has to scan historical attempts or infer availability from fragments.
    checkpointAvailable: v.optional(v.boolean()),
    // Terminal cloud workspaces are retried independently from job dispatch.
    // Keeping the due time on the attempt prevents a provider outage from
    // repeatedly monopolizing the fleet supervisor's minute sweep.
    cloudWorkspaceCleanupEligible: v.optional(v.boolean()),
    cleanupAttempts: v.optional(v.number()),
    cleanupNextRetryAt: v.optional(v.number()),
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
    .index("by_status_progress", ["status", "progressAt"])
    .index("by_cloud_workspace_cleanup_status", ["cloudWorkspaceCleanupEligible", "status", "providerTerminatedAt", "cleanupNextRetryAt"])
    .index("by_provider_termination_cleanup_retry", ["providerName", "providerTerminatedAt", "cleanupNextRetryAt"]),

  // Convex is the sole authority for one logical Trigger launch. A receipt is
  // append-only across generations; transport ambiguity only changes its
  // reconciliation status and lease, never its identity, payload, or machine.
  dispatchReceipts: defineTable({
    jobId: v.id("jobs"),
    attempt: v.number(),
    generation: v.number(),
    phase: v.string(),
    dispatchId: v.string(),
    authorityDigest: v.string(),
    workOrderRevisionDigest: v.string(),
    triggerMachinePreset: v.string(),
    triggerMachineReason: v.string(),
    payloadJson: v.string(),
    payloadDigest: v.string(),
    receiptDigest: v.string(),
    // Present only when a resume receipt, rather than the generic queue scan,
    // selected this normal dispatch. These fields participate in both receipt
    // hashing and the exact replay lookup.
    sourceSupervisorControlReceiptId: v.optional(
      v.id("missionSupervisorControls"),
    ),
    sourceSupervisorFleetDigest: v.optional(v.string()),
    sourceSupervisorMemberDigest: v.optional(v.string()),
    // "claimed" is executable only while the jobs projection still names the
    // same running dispatch. Terminal/continuation writers close it; a
    // paused/cancelled worker or a response-lost review may remain
    // historical-claimed solely for its one exact fenced final callback.
    status: v.string(), // reserved | reconciling | claimed | closed | superseded
    workerRunId: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    closeReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_job_generation", ["jobId", "generation"])
    .index("by_status_lease", ["status", "leaseUntil"])
    .index("by_supervisor_control_member", [
      "sourceSupervisorControlReceiptId",
      "jobId",
    ])
    .index("by_digest", ["receiptDigest"]),

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
    handoffProtocolVersion: v.optional(v.number()),
    parentMissionId: v.id("missions"),
    planDigest: v.string(),
    planGeneration: v.number(),
    sourceNodeId: v.string(),
    sourceJobId: v.id("jobs"),
    sourceAttempt: v.number(),
    sourceSteerRevision: v.number(),
    authorityDigest: v.optional(v.string()),
    schedulingBindingDigest: v.optional(v.string()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    workReceiptId: v.optional(v.id("workReceipts")),
    workReceiptDigest: v.optional(v.string()),
    acceptedResultDigest: v.optional(v.string()),
    evidenceDigest: v.optional(v.string()),
    terminalEventKey: v.optional(v.string()),
    reviewReceiptId: v.optional(v.id("reviewReceipts")),
    reviewReceiptDigest: v.optional(v.string()),
    integrationAttemptId: v.optional(v.id("integrationAttempts")),
    integrationAttempt: v.optional(v.number()),
    integrationGeneration: v.optional(v.number()),
    integrationEffectId: v.optional(v.string()),
    integrationBindingDigest: v.optional(v.string()),
    integrationTerminalReceiptId: v.optional(v.id("integrationTerminalReceipts")),
    integrationTerminalReceiptDigest: v.optional(v.string()),
    integrationReceiptDigest: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    repository: v.optional(v.string()),
    sourceAdmissionDigest: v.optional(v.string()),
    sourceBranch: v.optional(v.string()),
    sourceHeadSha: v.optional(v.string()),
    integrationBranch: v.optional(v.string()),
    integrationHeadSha: v.optional(v.string()),
    artifactRefs: v.array(v.string()),
    acceptedResultProjectionDigest: v.optional(v.string()),
    handoffPayloadDigest: v.optional(v.string()),
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
    authorityDigest: v.optional(v.string()),
    schedulingBindingDigest: v.optional(v.string()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    missionGroupId: v.optional(v.string()),
    projectGroupId: v.optional(v.string()),
    integrationLineage: v.optional(v.string()),
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
    // Timestamp of the exact earlier provider observation that proved the
    // expected base. Focused repair inherits it; Convex never fabricates a
    // fresh observation timestamp for an unobserved ref.
    expectedIntegrationBaseObservedAt: v.optional(v.number()),
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
    workOrderRevisionDigest: v.optional(v.string()),
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
    authorityDigest: v.optional(v.string()),
    schedulingBindingDigest: v.optional(v.string()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    repository: v.optional(v.string()),
    missionGroupId: v.optional(v.string()),
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
    protocolVersion: v.optional(v.literal(2)),
    jobId: v.id("jobs"),
    attempt: v.number(),
    receiptDigest: v.optional(v.string()),
    terminalCode: v.optional(v.string()),
    recoveryDisposition: v.optional(v.union(
      v.literal("none"),
      v.literal("retryable"),
      v.literal("remediable"),
      v.literal("needs_input"),
      v.literal("operator_stop"),
    )),
    observedInputRevision: v.optional(v.number()),
    authorityDigest: v.optional(v.string()),
    schedulingBindingDigest: v.optional(v.string()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
    repository: v.optional(v.string()),
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

  // One irrevocable, hash-only reservation per immutable work-order revision
  // fences the optional paid Novita draft across all worker retries. A lost
  // worker deliberately leaves this held rather than risking a second egress.
  novitaPatchProposalReceipts: defineTable({
    protocolVersion: v.literal(1),
    workOrderRevisionId: v.id("workOrderRevisions"),
    workOrderRevision: v.number(),
    workOrderRevisionDigest: v.string(),
    jobId: v.id("jobs"),
    canonicalProjectId: v.string(),
    repository: v.optional(v.string()),
    schedulingBindingDigest: v.string(),
    authorityDigest: v.string(),
    workAttemptId: v.id("workAttempts"),
    ownerAttempt: v.number(),
    ownerWorkerRunId: v.string(),
    ownerDispatchReceiptDigest: v.string(),
    ownerDispatchPayloadDigest: v.string(),
    adapterId: v.literal("novita-qwen-patch-proposer-v1"),
    configDigest: v.string(),
    endpointId: v.string(),
    // New reservations always write this immutable work-order proof. Optional
    // preserves readability of any pre-hardening receipt, which remains held
    // and can never trigger another paid call.
    policyTaskDigest: v.optional(v.string()),
    requestDigest: v.string(),
    sourceFileCount: v.number(),
    inputBytes: v.number(),
    reservationDigest: v.string(),
    status: v.union(v.literal("reserved"), v.literal("settled")),
    outcome: v.optional(v.union(
      v.literal("proposed"), v.literal("no_change"), v.literal("skipped"),
      v.literal("unavailable"), v.literal("rejected"),
    )),
    outcomeDigest: v.optional(v.string()),
    outputBytes: v.optional(v.number()),
    failureClass: v.optional(v.union(
      v.literal("configuration"), v.literal("input"), v.literal("transport"),
      v.literal("timeout"), v.literal("http"), v.literal("response"),
    )),
    reservedAt: v.number(),
    settledAt: v.optional(v.number()),
  }).index("by_work_order_revision", ["workOrderRevisionId"]),

  // Cold, append-only repository review evidence. It is content-addressed
  // and never patched; jobs retain only the small binding fields above.
  reviewReceipts: defineTable({
    jobId: v.id("jobs"),
    attempt: v.number(),
    authorityDigest: v.optional(v.string()),
    schedulingBindingDigest: v.optional(v.string()),
    workOrderRevisionId: v.optional(v.id("workOrderRevisions")),
    workOrderRevision: v.optional(v.number()),
    workOrderRevisionDigest: v.optional(v.string()),
    canonicalProjectId: v.optional(v.string()),
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
    .index("by_job", ["jobId"])
    .index("by_job_status", ["jobId", "status"]),

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
    // Mood rows keep their model-originating thread so a delayed answer from
    // another conversation cannot recolour the active one.
    source: v.optional(v.string()),
    threadId: v.optional(v.string()),
    // The live-mode row uses these to fence delayed claims and releases from a
    // superseded browser start. Other UI rows intentionally leave them empty.
    liveLeaseId: v.optional(v.string()),
    liveLeaseSequence: v.optional(v.number()),
    // Standby wake recognition has an independent lease. Its generation token
    // turns a local timeout/release into a durable tombstone, so a delayed
    // network mutation cannot restart a recognizer after it has stopped.
    standbyLeaseId: v.optional(v.string()),
    standbyLeaseSequence: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Immutable revocations for individual standby wake leases. This remains
  // separate from the singleton active-lease row because an older network
  // request must stay blocked after later tabs claim and release that row.
  standbyListenerRevocations: defineTable({
    leaseId: v.string(),
    client: v.string(),
    sequence: v.number(),
    releasedAt: v.number(),
  }).index("by_leaseId", ["leaseId"]),

  // Web-push subscriptions (per device) — JARVIS pings the phone even when closed.
  pushSubs: defineTable({
    endpoint: v.string(),
    keys: v.object({ p256dh: v.string(), auth: v.string() }),
    createdAt: v.number(),
  }).index("by_endpoint", ["endpoint"]),

  // Which categories are allowed to interrupt Daniel, and when.
  //
  // Single row (key "default"). Deliberately fail-OPEN on a missing row: a
  // never-configured install should still deliver a price hit rather than
  // silently swallow it. Only an explicit false suppresses a category, so
  // silence is always something Daniel chose.
  notificationPrefs: defineTable({
    key: v.string(), // "default"
    pushEnabled: v.boolean(), // master switch; false = in-app bell only
    categories: v.object({
      price_hunt: v.boolean(),
      errand: v.boolean(),
      work: v.boolean(),
      reminder: v.boolean(),
      incident: v.boolean(),
    }),
    // Local-time quiet window, e.g. 23 -> 7. Suppresses push only; the bell
    // still fills up, so nothing is lost, just deferred.
    quietHoursStart: v.optional(v.number()),
    quietHoursEnd: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

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
  // here — his atelier. `data` is the editable source (JSON/markdown). New
  // binary assets live under a private opaque R2 key; `url`/`thumb` remain for
  // legacy public objects and first-party display routes only.
  creations: defineTable({
    kind: v.string(), // "canvas" | "chart" | "image" | "pdf" | "doc"
    title: v.string(),
    data: v.optional(v.string()), // JSON (canvas/chart) or markdown (doc)
    url: v.optional(v.string()), // legacy public URL or first-party media route
    thumb: v.optional(v.string()), // legacy preview URL or first-party media route
    assetR2Key: v.optional(v.string()), // private `owners/daniel/creations/.../asset`
    assetContentType: v.optional(v.string()), // media type verified again at read time
    category: v.optional(v.string()), // emails, notes, boards, mind maps, etc.
    folder: v.optional(v.string()), // human-readable hierarchy: Projects / X, Visuals / Boards…
    project: v.optional(v.string()),
    inquiry: v.optional(v.string()),
    threadId: v.optional(v.string()), // conversation that produced the creation
    sourceFiles: v.optional(v.array(v.object({ fileId: v.id("files"), name: v.string() }))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_kind", ["kind", "updatedAt"])
    .index("by_category", ["category", "updatedAt"])
    .index("by_folder", ["folder", "updatedAt"])
    .index("by_project", ["project", "updatedAt"])
    .index("by_thread", ["threadId", "updatedAt"])
    .index("by_url", ["url", "updatedAt"])
    .index("by_thumb", ["thumb", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  // Conversational travel remains deliberately separate from Daniel's saved
  // creations until he explicitly locks a reviewed plan. `data` is a bounded
  // TripDoc-compatible JSON snapshot; planRevision fences owner itinerary
  // writes while providers can merge their own subtree without replacing it.
  travelDrafts: defineTable({
    threadId: v.string(),
    state: v.union(v.literal("draft"), v.literal("locked")),
    schemaVersion: v.number(),
    title: v.string(),
    destination: v.string(),
    data: v.string(),
    planRevision: v.number(),
    sourceMessageId: v.optional(v.id("chatMessages")),
    lockedCreationId: v.optional(v.id("creations")),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_thread_state_updated", ["threadId", "state", "updatedAt"])
    .index("by_expiry", ["expiresAt"]),

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

  // Google OAuth connection (Feature 4a). One row per provider — today only
  // "google". Stores the refresh token AES-256-GCM-encrypted at rest; the
  // plaintext token never touches Convex. See src/lib/google-oauth.ts.
  googleAccounts: defineTable({
    provider: v.string(), // "google"
    encryptedRefreshToken: v.string(), // base64 AES-256-GCM envelope (schema byte + nonce + tag + ciphertext)
    scope: v.string(),
    email: v.optional(v.string()), // connected Google account address, for UI display only
    connectedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider", ["provider"]),

  // Browser errands: JARVIS acting as Daniel in a real logged-in browser.
  //
  // Daniel approves the PLAN once, and the plan is the permission boundary —
  // `envelope` pins the hosts, action types and send budget that jarvis-browser
  // enforces on every step. Anything outside it escalates rather than
  // proceeding. No credential material is ever stored here: `credentialId` is
  // an opaque handle into the root-only sealed store on the browser host, and
  // Convex (like the model) can never resolve it to a value.
  browserErrands: defineTable({
    objective: v.string(),
    credentialId: v.optional(v.string()),
    // Normalized, bounded proposal envelope. It is snapshotted into
    // `approvedEnvelope` with the executable steps when Daniel approves.
    envelope: browserErrandEnvelopeValidator,
    // Human-readable, server-derived summaries of `executionSteps`, shown at
    // approval time. It is never an execution input.
    plan: v.array(v.string()),
    // Legacy records may not have a sealed executable plan. They are kept for
    // audit, but cannot be approved for execution.
    executionSteps: v.optional(v.array(browserErrandStepValidator)),
    approvedSteps: v.optional(v.array(browserErrandStepValidator)),
    approvedEnvelope: v.optional(browserErrandEnvelopeValidator),
    status: v.string(), // proposed | approved | declined | expired | running | done | failed | blocked | needs_step_approval
    result: v.optional(v.string()),
    escalation: v.optional(v.string()), // why it paused, when status = needs_step_approval
    sends: v.optional(v.number()),
    chatId: v.optional(v.string()),
    requestedAt: v.number(),
    resolvedAt: v.optional(v.number()),
    approvalExpiresAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    // A random server-issued fence. It is never surfaced to the UI or model;
    // only the claimant can finish the run it started.
    leaseToken: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    // The browser service receives only the remaining bounded lifetime at
    // claim time. This absolute deadline lets Vercel stop before a late lease
    // finalization and gives audit/recovery an unambiguous browser cutoff.
    browserDeadlineAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_status", ["status", "requestedAt"])
    .index("by_status_lease", ["status", "leaseUntil"])
    .index("by_status_finished", ["status", "finishedAt"])
    .index("by_chat", ["chatId", "requestedAt"]),
});
