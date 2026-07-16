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

  // Conversation history per thread (survives reloads).
  chat: defineTable({
    threadId: v.string(),
    role: v.string(), // "user" | "assistant"
    content: v.string(),
    createdAt: v.number(),
  }).index("by_thread", ["threadId", "createdAt"]),

  // Queue transport for the subscription brain: UI writes a pending user row;
  // the Trigger dispatcher claims it, opens a streaming assistant row, streams
  // Claude Code deltas in, finalizes. UI subscribes reactively.
  chatMessages: defineTable({
    threadId: v.string(),
    role: v.string(), // "user" | "assistant"
    text: v.string(),
    status: v.string(), // "pending" | "streaming" | "done" | "error"
    model: v.optional(v.string()), // which tier answered (haiku|sonnet|opus|flash|live)
    // Persistent media card: everything JARVIS shows also lands in the stream
    // so Daniel can always get back to it later.
    attachment: v.optional(
      v.object({ type: v.string(), value: v.string(), title: v.optional(v.string()) }),
    ),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_status", ["status", "createdAt"]),

  chatSessions: defineTable({
    threadId: v.string(),
    status: v.string(), // "idle" | "working"
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

  // Background agent jobs: brain enqueues, agent-runner Trigger task executes
  // (Claude Code / Opus, optional repo clone+push) and reports back into chat.
  // Price watches — the cron re-prices and pings when a product drops.
  watches: defineTable({
    query: v.string(),
    targetGbp: v.optional(v.number()),
    lastGbp: v.optional(v.number()),
    status: v.string(), // active | cancelled
    checkedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_status", ["status"]),

  // Timed reminders — delivered by the agent-runner cron as push + weave.
  reminders: defineTable({
    text: v.string(),
    at: v.number(), // epoch ms when it should fire
    status: v.string(), // pending | delivering | done | cancelled
    createdAt: v.number(),
  }).index("by_status", ["status", "at"]),

  jobs: defineTable({
    repo: v.optional(v.string()),
    task: v.string(),
    status: v.string(), // pending | running | done | error
    result: v.optional(v.string()),
    readonly: v.optional(v.boolean()), // if true, runner never commits/pushes
    model: v.optional(v.string()), // optional model override (haiku|sonnet|opus)
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
    agentId: v.optional(v.string()),
    risk: v.optional(v.string()), // low | medium | high | consequential
    priority: v.optional(v.number()), // 0-100
    approvalRequired: v.optional(v.boolean()),
    approvalStatus: v.optional(v.string()), // pending | approved | declined
    stage: v.optional(v.string()),
    percent: v.optional(v.number()),
    heartbeatAt: v.optional(v.number()),
    checkpoint: v.optional(v.string()),
    attempt: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    parentJobId: v.optional(v.string()),
    dependsOn: v.optional(v.array(v.string())),
    acceptanceCriteria: v.optional(v.array(v.string())),
    modelReason: v.optional(v.string()),
    branch: v.optional(v.string()),
    pullRequestUrl: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_mission", ["missionId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_agent", ["agentId", "createdAt"]),

  // Orchestrated agent fleets: one mission = a decomposed goal running as
  // parallel jobs; when the last one lands, a synthesis pass merges the
  // results into ONE coherent report back to Daniel.
  missions: defineTable({
    goal: v.string(),
    status: v.string(), // running | synthesizing | done | failed
    agentCount: v.number(),
    summary: v.optional(v.string()),
    originThreadId: v.optional(v.string()),
    managerAgentId: v.optional(v.string()),
    priority: v.optional(v.number()),
    risk: v.optional(v.string()),
    phase: v.optional(v.string()),
    percent: v.optional(v.number()),
    acceptanceCriteria: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

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
    data: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId", "createdAt"])
    .index("by_mission", ["missionId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

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
    status: v.string(), // open | working | resolved | dismissed
    jobId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_fingerprint", ["fingerprint"])
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_kind", ["kind", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  // Proactive insights the insight engine generates + surfaces (chat/notification).
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
