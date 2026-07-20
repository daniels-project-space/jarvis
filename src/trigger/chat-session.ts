import { schedules, task, tasks } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { CAPABILITIES, INFRA_MAP, PERSONA, REMEMBER } from "../lib/persona";
import { visualInitiativeDirective } from "../lib/visual-initiative";
import { visibleTurnText } from "../lib/host-context";
import { buildContext } from "../lib/context";
import { codexConversationExecPrefix, codexModelFor, pickConversationTier } from "./model-policy";
import {
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  type AgentProvider,
} from "./subscription-runtime";
import {
  FOREGROUND_CONCURRENCY,
  FOREGROUND_MAX_DURATION_SECONDS,
  FOREGROUND_QUEUE,
  FOREGROUND_TURN_TIMEOUT_MS,
  type ForegroundTurnPayload,
} from "./foreground-policy";
import { CodexAppServer, type CodexTurnResult } from "./codex-app-server";
import {
  AgentToolBridge,
  JARVIS_DYNAMIC_TOOLS,
  JARVIS_TOOL_INSTRUCTIONS,
} from "./agent-tool-bridge";
import { StreamPublisher } from "./stream-publisher";
import {
  acquireRunnerLease,
  isLegacyRunnerClaimValidationError,
  WarmHandoffController,
} from "./foreground-handoff";

function cliArgs(provider: AgentProvider, prompt: string, tier: string, json = false): string[] {
  if (provider !== "codex") throw new Error("Jarvis permits only the Codex CLI runtime");
  const args = codexConversationExecPrefix(tier);
  if (json) args.push("--json");
  args.push(prompt);
  return args;
}

// Subscription brain: each queued chat turn runs the Codex CLI headlessly,
// with metered API keys blanked and only the subscription
// credential exposed. This is conversational—repository work is delegated to
// the durable agent runner. Bounded memory and project context come from Convex.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
// A runner remains active for almost twelve minutes. Nine minutes in, it boots
// its successor while the current CLI stays available; the successor takes
// over the Convex lease only after its app-server is fully initialised.
const RUN_BUDGET_MS = 690_000;
const HANDOFF_AFTER_MS = 540_000;
const HANDOFF_RETRY_MS = 30_000;
const HANDOFF_FAILURE_RETRY_MS = 2_000;
const HANDOFF_MAX_ATTEMPTS = 5;
const HANDOFF_TRIGGER_TIMEOUT_MS = 15_000;
const PENDING_SIGNAL_RETRY_MS = 1_000;

async function convexCall(kind: "query" | "mutation", path: string, args: unknown) {
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) throw new Error("JARVIS_WORKER_TOKEN is not configured");
  const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      args: { ...((args ?? {}) as Record<string, unknown>), workerToken },
      format: "json",
    }),
  });
  const body = await response.json().catch(() => null) as {
    status?: string;
    value?: unknown;
    errorMessage?: string;
  } | null;
  if (!response.ok || !body || body.status === "error") {
    throw new Error(
      `Convex ${kind} ${path} failed: ${String(body?.errorMessage ?? response.status).slice(0, 300)}`,
    );
  }
  return body.value;
}

async function convexMutation(path: string, args: unknown) {
  return convexCall("mutation", path, args);
}

function waitForPending(
  client: ConvexClient,
  workerToken: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      signal?.removeEventListener("abort", aborted);
      unsubscribe();
      resolve(value);
    };
    const aborted = () => finish(false);
    const retryAfterSubscriptionError = () => {
      if (settled || reconnectTimer) return;
      // Keep the owning process alive and fall back to one bounded claim per
      // second while Convex realtime reconnects. Exiting here would recreate
      // the cold handoff gap even though this runner still owns the lease.
      reconnectTimer = setTimeout(
        () => finish(true),
        Math.max(1, Math.min(PENDING_SIGNAL_RETRY_MS, timeoutMs)),
      );
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      unsubscribe = client.onUpdate(
        api.chatQueue.pendingSignal,
        { workerToken },
        (messageId) => { if (messageId) finish(true); },
        retryAfterSubscriptionError,
      );
    } catch {
      retryAfterSubscriptionError();
    }
  });
}

type QueueClaim = {
  threadId: string;
  userText: string;
  assistantId: string;
  history: Array<{ role: string; text: string }>;
};

async function claimChatMessage(targetMessageId: string | undefined, runnerId: string) {
  const path = targetMessageId ? "chatQueue:claimMessage" : "chatQueue:claimNext";
  const legacyArgs = targetMessageId ? { messageId: targetMessageId } : {};
  try {
    return await convexMutation(path, { ...legacyArgs, runnerId }) as QueueClaim | null;
  } catch (error) {
    // During a provider rolling deploy, the new Trigger worker can briefly see
    // the old Convex validator. Retry only that pre-execution validation error;
    // ambiguous transport failures must never risk claiming a second message.
    if (!isLegacyRunnerClaimValidationError(error)) throw error;
    return await convexMutation(path, legacyArgs) as QueueClaim | null;
  }
}

function conversationPreamble() {
  return PERSONA +
    `\n\n${CAPABILITIES}\n\n${INFRA_MAP}\n\nCurrent date: ${new Date().toDateString()}.\n\n${REMEMBER}\n\n` +
    JARVIS_TOOL_INSTRUCTIONS + " " +
    `Answer first and keep the default spoken reply to one concise sentence. Never narrate context, memory, shell commands, or tool plumbing.`;
}

async function runTurn(
  server: CodexAppServer,
  conversationId: string,
  assistantId: string,
  userText: string,
  history: { role: string; text: string }[],
  contextBlock: string,
  model: string,
){
  const publisher = new StreamPublisher((text, revision) =>
    convexMutation("chatQueue:updateStream", { messageId: assistantId, text, revision }),
  );
  publisher.start();
  let result: CodexTurnResult | null = null;
  try {
    result = await server.runTurn({
      conversationId,
      turnKey: assistantId,
      userText,
      history,
      contextBlock,
      turnDirective: visualInitiativeDirective(visibleTurnText(userText)),
      preamble: conversationPreamble(),
      modelTier: model,
      onDelta: (delta) => publisher.push(delta),
    });
  } finally {
    // This is the decisive ordering barrier: no stream mutation remains alive
    // when processChatQueue writes the final answer.
    await publisher.close();
  }
  if (!result) throw new Error("Codex conversation turn ended without a result");
  return { ...result, sessionId: result.threadId, streamTiming: publisher.timing };
}

// Stage 0 capture: a fast Luna pass extracts durable facts from the turn and
// persists them (decoupled from the conversation = far more reliable than
// in-turn tool calls; the mem0 / Letta sleep-time pattern).
async function extractAndSave(
  provider: AgentProvider,
  bin: string,
  env: NodeJS.ProcessEnv,
  userText: string,
  assistantText: string,
): Promise<number> {
  const prompt =
    "From the exchange below, extract ONLY durable facts, preferences, decisions, or tasks worth " +
    "remembering long-term about Daniel or his projects. Output STRICT JSON: an array of " +
    '{"kind","title","body","tags"} where kind is one of fact|preference|decision|task|project. ' +
    "Output [] if nothing is worth remembering. No prose, JSON only.\n\n" +
    `User: ${userText}\nAssistant: ${assistantText}`;
  const out = await new Promise<string>((resolve) => {
    const p = spawn(bin, cliArgs(provider, prompt, "luna"), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let o = "";
    const timeout = setTimeout(() => p.kill("SIGKILL"), 90_000);
    p.stdout.on("data", (d) => (o += d.toString()));
    p.on("close", () => {
      clearTimeout(timeout);
      resolve(o);
    });
    p.on("error", () => {
      clearTimeout(timeout);
      resolve("");
    });
  });
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]) as unknown;
  } catch {
    return 0;
  }
  const items = Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  let n = 0;
  for (const it of items.slice(0, 8)) {
    if (!it.title || !it.body) continue;
    await convexMutation("memory:write", {
      kind: String(it.kind || "fact"),
      title: String(it.title).slice(0, 120),
      body: String(it.body).slice(0, 1200),
      tags: Array.isArray(it.tags) ? it.tags.map(String).slice(0, 6) : [],
    }).catch(() => {});
    n++;
  }
  return n;
}

async function processChatQueue(
  targetMessageId?: string,
  source = "conversation",
  handoffFrom?: string,
  handoffConversations: ForegroundTurnPayload["handoffConversations"] = [],
) {
  // Foreground Jarvis is deliberately pinned to Daniel's ChatGPT subscription.
  // The old provider lookup now always returns Codex, so querying it added a
  // network round trip to every message without changing the selected brain.
  const provider: AgentProvider = "codex";
  const dispatchToken = process.env.JARVIS_DISPATCH_TOKEN;
  if (!dispatchToken) return { processed: 0, error: "JARVIS_DISPATCH_TOKEN is not configured" };
  const prepared = prepareSubscriptionEnv(provider);
  if (prepared.error) return { processed: 0, error: prepared.error };
  const env = prepared.env;
  const bin = resolveSubscriptionAgentBin(provider);
  if (!bin) return { processed: 0, error: `${provider} binary not found` };
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) return { processed: 0, error: "JARVIS_WORKER_TOKEN is not configured" };
  const runnerId = randomUUID();
  const bridge = new AgentToolBridge(dispatchToken);
  const server = new CodexAppServer(bin, env, FOREGROUND_TURN_TIMEOUT_MS, {
    dynamicTools: JARVIS_DYNAMIC_TOOLS,
    onDynamicToolCall: (call) => bridge.invoke(call),
  });
  const workerStartedAt = Date.now();
  let appServerReadyMs = 0;
  let conversationPrewarmMs = 0;
  let prewarmedConversations = 0;
  let serverReady = false;
  // A handoff candidate starts the pinned app-server and seeds the most recent
  // model-visible conversation before taking the lease. The prior worker stays
  // alive until the lease change arrives over Convex realtime.
  if (source === "warm-handoff") {
    await server.start();
    serverReady = true;
    const serverReadyAt = Date.now();
    appServerReadyMs = serverReadyAt - workerStartedAt;
    prewarmedConversations = await server.prewarmConversations(
      handoffConversations ?? [],
      conversationPreamble(),
    );
    conversationPrewarmMs = Date.now() - serverReadyAt;
  }
  let ownsLease: boolean;
  try {
    ownsLease = await acquireRunnerLease({
      acquire: () => convexMutation("chatQueue:touchRunner", {
        runnerId,
        takeoverFrom: source === "warm-handoff" ? handoffFrom : undefined,
      }) as Promise<boolean>,
    });
  } catch (error) {
    server.stop();
    throw error;
  }
  if (!ownsLease) {
    server.stop();
    return { processed: 0, warmRunner: true };
  }
  const client = new ConvexClient(CONVEX_URL);
  let leaseActive = true;
  const loopAbort = new AbortController();
  const handoff = new WarmHandoffController<ForegroundTurnPayload>({
    runnerId,
    payload: () => ({
      source: "warm-handoff",
      handoffFrom: runnerId,
      handoffConversations: server.handoffConversations(1),
    }),
    launch: async (payload, attempt) => Boolean(await tasks.trigger(
      "jarvis-chat-turn",
      payload,
      { idempotencyKey: `jarvis-warm-${runnerId}-${attempt}` },
    ).catch(() => null)),
    onTakeover: () => {
      leaseActive = false;
      loopAbort.abort();
    },
    maxAttempts: HANDOFF_MAX_ATTEMPTS,
    retryDelayMs: HANDOFF_RETRY_MS,
    failureRetryDelayMs: HANDOFF_FAILURE_RETRY_MS,
    launchTimeoutMs: HANDOFF_TRIGGER_TIMEOUT_MS,
  });
  const stopLeaseWatch = client.onUpdate(
    api.chatQueue.runnerLeaseForWorker,
    { workerToken },
    (lease) => handoff.observeRunner(lease?.runnerId),
    () => {},
  );
  const heartbeat = setInterval(() => void convexMutation("chatQueue:touchRunner", { runnerId })
    .then((stillOwner) => {
      if (stillOwner === false) handoff.markTakenOver();
    })
    .catch(() => {}), 10_000);
  const handoffTimer = setTimeout(() => void handoff.start(), HANDOFF_AFTER_MS);

  const started = Date.now();
  const timings: Array<{
    claimMs: number;
    contextMs: number;
    modelMs: number;
    appServerReadyMs: number;
    conversationReadyMs: number;
    turnResponseMs: number;
    firstDeltaMs: number | null;
    generationMs: number;
    modelCompletedMs: number;
    firstStreamCommitMs: number | null;
    streamBufferMs: number | null;
    streamCommitMs: number | null;
    bufferedEventCount: number;
    firstDeltaBeforeTurnResponse: boolean;
    finalizeMs: number;
    deliveredMs: number;
    memoryMs: number;
  }> = [];
  let processed = 0;
  let handoffReady = false;
  try {
    // Prewarm even when the scheduled recovery task found no message. This is
    // the always-available main Jarvis, separate from durable specialist work.
    if (!serverReady) {
      const serverStartedAt = Date.now();
      await server.start();
      appServerReadyMs = Date.now() - serverStartedAt;
      serverReady = true;
    }
  while (leaseActive && Date.now() - started < RUN_BUDGET_MS) {
    const claimStarted = Date.now();
    const claim = await claimChatMessage(targetMessageId, runnerId);
    const claimedAt = Date.now();
    if (!claim) {
      targetMessageId = undefined;
      const remaining = RUN_BUDGET_MS - (Date.now() - started);
      if (remaining <= 0 || !(await waitForPending(client, workerToken, remaining, loopAbort.signal))) break;
      continue;
    }
    try {
      const visibleUserText = visibleTurnText(claim.userText);
      const contextStarted = Date.now();
      const context = await buildContext(visibleUserText);
      const contextReadyAt = Date.now();
      const model = pickConversationTier(visibleUserText);
      const turn = await runTurn(
        server,
        claim.threadId,
        claim.assistantId,
        claim.userText,
        claim.history,
        context,
        model,
      );
      const modelFinishedAt = Date.now();
      const finalText =
        turn.finalText.trim() ||
        (turn.code === 0
          ? "(the agent finished without producing text)"
          : `⚠️ run failed (exit ${turn.code}). ${turn.stderr || ""}`.trim());
      const finalizeStarted = Date.now();
      await convexMutation("chatQueue:finalize", {
        messageId: claim.assistantId,
        threadId: claim.threadId,
        status: turn.finalText.trim() ? "done" : "error",
        finalText,
        model: `codex · ${codexModelFor(model).model}`,
      });
      const deliveredAt = Date.now();
      // Memory capture is a separate background task. It must never hold the
      // warm conversational worker hostage after Daniel already has a reply.
      if (turn.finalText.trim()) void tasks.trigger("jarvis-chat-memory", {
        userText: visibleUserText,
        assistantText: turn.finalText,
      }).catch(() => {});
      const memoryFinishedAt = Date.now();
      const streamBufferMs = turn.streamTiming.firstDeltaMs === null || turn.streamTiming.firstPublishStartedMs === null
        ? null
        : Math.max(0, turn.streamTiming.firstPublishStartedMs - turn.streamTiming.firstDeltaMs);
      const streamCommitMs = turn.streamTiming.firstPublishStartedMs === null || turn.streamTiming.firstPublishCommittedMs === null
        ? null
        : Math.max(0, turn.streamTiming.firstPublishCommittedMs - turn.streamTiming.firstPublishStartedMs);
      timings.push({
        claimMs: claimedAt - claimStarted,
        contextMs: contextReadyAt - contextStarted,
        modelMs: modelFinishedAt - contextReadyAt,
        appServerReadyMs: turn.timing.appServerReadyMs,
        conversationReadyMs: turn.timing.conversationReadyMs,
        turnResponseMs: turn.timing.turnResponseMs,
        firstDeltaMs: turn.timing.firstDeltaMs,
        generationMs: turn.timing.generationMs,
        modelCompletedMs: turn.timing.modelCompletedMs,
        firstStreamCommitMs: turn.streamTiming.firstPublishCommittedMs === null
          ? null
          : contextReadyAt - claimStarted + turn.streamTiming.firstPublishCommittedMs,
        streamBufferMs,
        streamCommitMs,
        bufferedEventCount: turn.timing.bufferedEventCount,
        firstDeltaBeforeTurnResponse: turn.timing.firstDeltaBeforeTurnResponse,
        finalizeMs: deliveredAt - finalizeStarted,
        deliveredMs: deliveredAt - claimStarted,
        memoryMs: memoryFinishedAt - deliveredAt,
      });
      processed += 1;
    } catch (error: unknown) {
      await convexMutation("chatQueue:finalize", {
        messageId: claim.assistantId,
        threadId: claim.threadId,
        status: "error",
        finalText: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => {});
    }
    // After its exact wake-up message, retain this authenticated CLI process
    // and drain rapid follow-ups. Duplicate queued wake tasks become no-ops.
    targetMessageId = undefined;
  }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(handoffTimer);
    if (leaseActive) await handoff.ensureLaunched();
    handoffReady = handoff.state.takenOver;
    handoff.stop();
    stopLeaseWatch();
    client.close();
    server.stop();
    await convexMutation("chatQueue:releaseRunner", { runnerId }).catch(() => {});
  }
  return {
    processed,
    timings,
    workerTiming: {
      source,
      appServerReadyMs,
      conversationPrewarmMs,
      prewarmedConversations,
      handoffReady,
    },
  };
}

export const chatMemory = task({
  id: "jarvis-chat-memory",
  queue: { name: "jarvis-memory", concurrencyLimit: 2 },
  machine: "small-1x",
  maxDuration: 180,
  run: async (payload: { userText: string; assistantText: string }) => {
    const provider: AgentProvider = "codex";
    const prepared = prepareSubscriptionEnv(provider);
    const bin = resolveSubscriptionAgentBin(provider);
    if (prepared.error || !bin) return { saved: 0, error: prepared.error ?? "Codex binary unavailable" };
    return { saved: await extractAndSave(provider, bin, prepared.env, payload.userText, payload.assistantText) };
  },
});

// Each committed turn starts immediately, then the worker stays warm briefly.
// Two lanes preserve an available Jarvis if one foreground answer runs longer.
export const chatTurn = task({
  id: "jarvis-chat-turn",
  queue: { name: FOREGROUND_QUEUE, concurrencyLimit: FOREGROUND_CONCURRENCY },
  machine: "small-1x",
  maxDuration: FOREGROUND_MAX_DURATION_SECONDS,
  run: async (payload: ForegroundTurnPayload) => processChatQueue(
    payload.messageId,
    payload.source,
    payload.handoffFrom,
    payload.handoffConversations,
  ),
});

// Recovery lane only: if an immediate trigger is lost between Vercel and
// Trigger, the next schedule drains the durable Convex queue.
export const chatDispatcher = schedules.task({
  id: "jarvis-chat-dispatcher",
  cron: "*/1 * * * *",
  queue: { name: "jarvis-foreground-recovery", concurrencyLimit: 1 },
  maxDuration: 60,
  run: async () => {
    const [lease, pendingMessageId] = await Promise.all([
      convexCall("query", "chatQueue:runnerLeaseForWorker", {}) as Promise<{ updatedAt?: number } | null>,
      convexCall("query", "chatQueue:pendingSignal", {}) as Promise<string | null>,
    ]);
    const warm = Boolean(lease?.updatedAt && Date.now() - lease.updatedAt < 25_000);
    if (warm) return { warm: true, pending: Boolean(pendingMessageId) };
    const handle = await tasks.trigger(
      "jarvis-chat-turn",
      { source: "recovery", messageId: pendingMessageId ?? undefined },
      { idempotencyKey: `jarvis-recovery-${Math.floor(Date.now() / 60_000)}` },
    );
    return { warm: false, pending: Boolean(pendingMessageId), runId: handle.id };
  },
});
