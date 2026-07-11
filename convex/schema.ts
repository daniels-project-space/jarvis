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
    .index("by_createdAt", ["createdAt"]),

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
    progress: v.optional(v.string()), // live activity line the runner streams
    startedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_status", ["status", "createdAt"]),

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
  }).index("by_status", ["status", "createdAt"]),

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
