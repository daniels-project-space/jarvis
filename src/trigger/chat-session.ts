import { metadata, schedules, task, tasks } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CAPABILITIES, INFRA_MAP, PERSONA, REMEMBER } from "../lib/persona";
import { visualInitiativeDirective } from "../lib/visual-initiative";
import { shouldCaptureDurableMemory } from "../lib/current-state";
import { memoryConfidence } from "../lib/memory-governance";
import { visibleTurnText } from "../lib/host-context";
import { buildContext } from "../lib/context";
import { isSpeculativeResearchApplicable } from "../lib/speculative-research";
import {
  buildBoundedFileContext,
  buildBoundedThreadFileCatalog,
  type ChatFileManifest,
  type ChatThreadFileCatalogItem,
} from "../lib/chat-files";
import { codexModelFor, codexReviewExecPrefix, pickConversationTier } from "./model-policy";
import { materializeCodexChatImages } from "./chat-image-input";
import {
  cleanupSubscriptionHome,
  consumeSubscriptionAuth,
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  verifyCodexSubscriptionPreflight,
  type AgentProvider,
} from "./subscription-runtime";
import {
  FOREGROUND_CONCURRENCY,
  FOREGROUND_ADMISSION_RESERVE_MS,
  canClaimForegroundTurn,
  FOREGROUND_HANDOFF_OVERLAP_MS,
  FOREGROUND_IDLE_TIMEOUT_MS,
  FOREGROUND_LANE_MAX_DURATION_SECONDS,
  FOREGROUND_MAX_DURATION_SECONDS,
  FOREGROUND_PROCESS_EXIT_RESERVE_MS,
  FOREGROUND_QUEUE,
  FOREGROUND_RUNNER_LEASE_MS,
  FOREGROUND_SESSION_RENEWAL_RESERVE_MS,
  FOREGROUND_TURN_TIMEOUT_MS,
  type ForegroundTurnPayload,
} from "./foreground-policy";
import { abortForegroundLeaseWork, waitForForegroundLease } from "./foreground-lease";
import { successorLane, taskForForegroundLane, type ForegroundLane } from "./foreground-lanes";
import { buildForegroundTiming, type ForegroundTurnTiming } from "./foreground-timing";
import { dispatchPendingForegroundRecovery } from "./foreground-recovery";
import { CodexAppServer, type CodexTurnInput } from "./codex-app-server";
import { ForegroundSessionOwner } from "./foreground-session";
import { MEMORY_SUBSCRIPTION_VALIDITY_MS } from "./subscription-validity";
import {
  AgentToolBridge,
  JARVIS_DYNAMIC_TOOLS,
  JARVIS_TOOL_INSTRUCTIONS,
} from "./agent-tool-bridge";
import { StreamPublisher } from "./stream-publisher";

// Subscription brain: each queued chat turn runs the Codex CLI headlessly,
// with metered API keys blanked and only the subscription
// credential exposed. This is conversational—repository work is delegated to
// the durable agent runner. Bounded memory and project context come from Convex.

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://tangible-goose-318.convex.cloud";
// A normal foreground runner lives for just under four hours. Its successor
// initializes during the final ten-minute overlap, but the Convex lease is
// transferred only after the active owner has stopped admissions and released
// it. The finite safety reserve leaves Trigger time to cancel and clean up.
const RUN_BUDGET_MS = FOREGROUND_MAX_DURATION_SECONDS * 1_000 - FOREGROUND_PROCESS_EXIT_RESERVE_MS;
const HANDOFF_AFTER_MS = RUN_BUDGET_MS - FOREGROUND_HANDOFF_OVERLAP_MS;

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

async function failForegroundStartup(message: string): Promise<never> {
  await convexMutation("incidents:report", {
    source: "jarvis-chat-turn",
    app: "jarvis",
    signature: `foreground-startup:${message.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 100)}`,
    message: `Foreground Jarvis could not start: ${message}`,
  }).catch(() => undefined);
  throw new Error(message);
}

async function settleUnclaimedForegroundStartupFailure(payload: ForegroundTurnPayload) {
  const dispatchEpoch = payload.dispatchEpoch;
  if (
    !payload.messageId
    || !payload.threadId
    || typeof dispatchEpoch !== "number"
    || !Number.isSafeInteger(dispatchEpoch)
    || dispatchEpoch < 0
  ) return false;
  // This hook runs only once Trigger has exhausted retries. Convex settles
  // the original wake-up only while its durable dispatch epoch is unchanged
  // and unclaimed; a concurrent recovery always wins instead of losing a live
  // reply to a delayed failure hook.
  return await convexMutation("chatQueue:failPendingStartup", {
    messageId: payload.messageId,
    threadId: payload.threadId,
    expectedDispatchEpoch: dispatchEpoch,
  }).catch(() => false);
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
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      unsubscribe();
      resolve(value);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    unsubscribe = client.onUpdate(
      api.chatQueue.pendingSignal,
      { workerToken },
      (pending) => { if (pending) finish(true); },
      () => finish(false),
    );
  });
}

type QueueClaim = {
  threadId: string;
  guest?: boolean;
  userText: string;
  requestId?: string;
  userMessageId: Id<"chatMessages">;
  assistantId: Id<"chatMessages">;
  claimToken: string;
  ownerToolAccess?: boolean;
  attemptCount: number;
  history: Array<{ role: string; text: string }>;
  researchPrefetch?: { basis: string; context: string; expiresAt: number };
  attachments: Array<ChatFileManifest & { r2Key: string; previewR2Key?: string }>;
  fileCatalog: ChatThreadFileCatalogItem[];
};

function conversationPreamble() {
  return PERSONA +
    `\n\n${CAPABILITIES}\n\n${INFRA_MAP}\n\n${REMEMBER}\n\n` +
    JARVIS_TOOL_INSTRUCTIONS + " " +
    `When Daniel's request implies a supported visual or live-data capability, execute the most specific safe tool before the final reply; never claim that you cannot show a map, chart, weather, search result, briefing, planner, or document when its tool is available. Then keep the default spoken reply to one concise sentence. Never narrate context, memory, shell commands, or tool plumbing.`;
}

// Luna is picked by pickConversationTier() only for short greetings and
// acknowledgements. On a cold runner, routing it onto the main conversation
// thread pays for thread/start's full baseInstructions — PERSONA plus the
// entire CAPABILITIES tool-routing manual and INFRA_MAP — just to say "hi".
// This keeps the same voice and full tool-bridge access (dynamic tools are
// wired at the app-server level below, not in this text) while dropping the
// routing/infra reference manual a greeting never needs. It only governs the
// one-time cost of starting the dedicated fast-lane thread in processChatQueue
// below; terra/sol always use the full conversationPreamble() on the main
// thread, unchanged.
function lunaFastPreamble() {
  return PERSONA +
    `\n\n${REMEMBER}\n\n` +
    JARVIS_TOOL_INSTRUCTIONS + " " +
    `Keep the default spoken reply to one concise sentence. Never narrate context, memory, shell commands, or tool plumbing.`;
}

async function runTurn(
  server: CodexAppServer,
  conversationId: string,
  assistantId: string,
  claimToken: string,
  userText: string,
  history: { role: string; text: string }[],
  contextBlock: string,
  imageInputs: NonNullable<CodexTurnInput["imageInputs"]>,
  model: string,
  hasPrivateFiles: boolean,
  invocationContext: CodexTurnInput["invocationContext"],
  toolHostContext: CodexTurnInput["toolHostContext"],
  cancellationAbort: AbortController,
  onStage?: (stage: "codexAck" | "firstDelta" | "firstConvexPaint") => void,
){
  const publisher = new StreamPublisher(
    (text, revision) => convexMutation("chatQueue:updateStream", { messageId: assistantId, claimToken, text, revision }),
    350,
    () => onStage?.("firstConvexPaint"),
    () => cancellationAbort.abort(),
  );
  publisher.start();
  try {
    const visualDirective = visualInitiativeDirective(visibleTurnText(userText));
    const freshContext = `${contextBlock}\n\nCurrent date: ${new Date().toDateString()}.` +
      (visualDirective ? `\n\n${visualDirective}` : "");
    let sawDelta = false;
    const result = await server.runTurn({
      conversationId,
      userText,
      history,
      contextBlock: freshContext,
      imageInputs,
      preamble: model === "luna" ? lunaFastPreamble() : conversationPreamble(),
      modelTier: model,
      allowTools: true,
      invocationContext,
      ...(toolHostContext ? { toolHostContext } : {}),
      signal: cancellationAbort.signal,
      onTurnStarted: () => onStage?.("codexAck"),
      onDelta: (delta) => {
        if (!sawDelta) {
          sawDelta = true;
          onStage?.("firstDelta");
        }
        publisher.push(delta);
      },
    });
    return { ...result, sessionId: result.threadId };
  } finally {
    // This is the decisive ordering barrier: no stream mutation remains alive
    // when processChatQueue writes the final answer.
    // Finalize writes the authoritative complete answer. Drain paints already
    // in flight, but do not serialize a redundant final snapshot before it.
    await publisher.close({ flushFinal: false });
    if (hasPrivateFiles) server.forgetConversation(conversationId);
  }
}

/**
 * A handoff candidate uses Convex's realtime lease row instead of polling. It
 * starts its Codex app-server before this wait; only the row's release (or one
 * bounded stale-lease deadline) permits it to become the next owner.
 */
function waitForRunnerAvailability(
  client: ConvexClient,
  workerToken: string,
  runnerId: string,
  timeoutMs: number,
): Promise<boolean> {
  return waitForForegroundLease({
    runnerId,
    timeoutMs,
    leaseMs: FOREGROUND_RUNNER_LEASE_MS,
    touch: (id) => convexMutation("chatQueue:touchRunner", { runnerId: id }) as Promise<boolean>,
    subscribe: (observe, onError) => client.onUpdate(
      api.chatQueue.runnerLeaseForWorker,
      { workerToken },
      observe,
      onError,
    ),
  });
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
  sourceMessageId?: string,
): Promise<number> {
  const prompt =
    "From the exchange below, extract ONLY durable facts, preferences, decisions, or tasks worth " +
    "remembering long-term about Daniel or his projects. Output STRICT JSON: an array of " +
    '{"kind","title","body","tags","confidence"} where kind is one of fact|preference|decision|task|project and confidence is 0 to 1. ' +
    "Output [] if nothing is worth remembering. No prose, JSON only.\n\n" +
    `User: ${userText}\nAssistant: ${assistantText}`;
  const out = await new Promise<string>((resolve) => {
    const p = spawn(bin, [...codexReviewExecPrefix("luna"), "-"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
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
    p.stdin.end(prompt, "utf8");
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
      confidence: memoryConfidence(it.confidence, 0.7),
      sourceMessageId,
    }).catch(() => {});
    n++;
  }
  return n;
}

async function processChatQueue(
  payload: ForegroundTurnPayload = {},
  lane: ForegroundLane = "primary",
) {
  let targetMessageId = payload.messageId;
  const source = payload.source ?? "conversation";
  // Foreground Jarvis is deliberately pinned to Daniel's ChatGPT subscription.
  // The old provider lookup now always returns Codex, so querying it added a
  // network round trip to every message without changing the selected brain.
  const provider: AgentProvider = "codex";
  const dispatchToken = process.env.JARVIS_DISPATCH_TOKEN;
  if (!dispatchToken) return await failForegroundStartup("JARVIS_DISPATCH_TOKEN is not configured");
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) return await failForegroundStartup("JARVIS_WORKER_TOKEN is not configured");
  // Duplicate wake tasks should exit before downloading credentials, cloning a
  // subscription home, or spawning the two subscription preflight commands.
  // The authoritative warm runner observes the durable queue via realtime.
  if (source !== "warm-handoff") {
    const existingLease = await convexCall("query", "chatQueue:runnerLeaseForWorker", {})
      .catch(() => null) as { updatedAt?: number } | null;
    if (existingLease?.updatedAt && Date.now() - existingLease.updatedAt < 25_000) {
      return { processed: 0, warmRunner: true };
    }
  }
  const prepared = await prepareSubscriptionEnv(provider, {
    scope: `foreground-${lane}`,
    minimumValidityMs: FOREGROUND_SESSION_RENEWAL_RESERVE_MS,
  });
  if (prepared.error) return await failForegroundStartup(prepared.error);
  const bin = resolveSubscriptionAgentBin(provider);
  if (!bin) {
    cleanupSubscriptionHome(prepared.env);
    return await failForegroundStartup(`${provider} binary not found`);
  }
  const preflight = verifyCodexSubscriptionPreflight(bin, prepared.env);
  if (preflight.error) {
    cleanupSubscriptionHome(prepared.env);
    return await failForegroundStartup(preflight.error);
  }
  const runnerId = randomUUID();
  const bridge = new AgentToolBridge(dispatchToken, {
    ownerToolReceiptSecret: workerToken,
    searchAttachedFiles: async (messageId, request) => await convexCall("query", "files:searchAttachedFiles", {
      messageId,
      mode: request.mode,
      text: request.query,
      fileId: request.fileId,
      afterOrdinal: request.afterOrdinal,
      limit: 6,
    }),
    authorizeTool: async (messageId, toolName) => await convexCall("query", "files:authorizeFileTool", {
      messageId,
      toolName,
    }) as { allowed: boolean; reason?: string },
  });
  const createServer = (serverEnv: NodeJS.ProcessEnv) => new CodexAppServer(bin, serverEnv, FOREGROUND_TURN_TIMEOUT_MS, {
      dynamicTools: JARVIS_DYNAMIC_TOOLS,
      dynamicToolsOnly: true,
      ephemeral: true,
      onDynamicToolCall: (call) => bridge.invoke(call),
      onAuthConsumed: () => consumeSubscriptionAuth(serverEnv),
    });
  let session: ForegroundSessionOwner<CodexAppServer>;
  try {
    session = new ForegroundSessionOwner({
      initial: prepared,
      scope: `foreground-${lane}`,
      createServer,
      prepare: (input) => prepareSubscriptionEnv(provider, input),
      preflight: (candidateEnv) => verifyCodexSubscriptionPreflight(bin, candidateEnv).error,
      cleanup: cleanupSubscriptionHome,
      onRenewalError: (signal) => {
        metadata.set("subscriptionSession", { status: "renewal_failed", signal });
        void metadata.flush().catch(() => undefined);
      },
      onRenewalReady: () => {
        metadata.set("subscriptionSession", { status: "ready" });
        void metadata.flush().catch(() => undefined);
      },
    });
  } catch (error) {
    cleanupSubscriptionHome(prepared.env);
    return await failForegroundStartup(error instanceof Error ? error.message : String(error));
  }
  const client = new ConvexClient(CONVEX_URL);
  // A handoff candidate pays startup cost inside the bounded overlap, but
  // never takes ownership from a still-serving runner.
  let ownsLease: boolean;
  try {
    // A lease means ready-to-claim, not merely "a container exists". Starting
    // first prevents API admission from trusting a worker stuck in CLI/auth
    // initialization.
    await session.start();
    ownsLease = source === "warm-handoff"
      ? await waitForRunnerAvailability(client, workerToken, runnerId, FOREGROUND_HANDOFF_OVERLAP_MS + FOREGROUND_RUNNER_LEASE_MS)
      : await convexMutation("chatQueue:touchRunner", { runnerId }) as boolean;
  } catch (error) {
    client.close();
    await session.close();
    throw error;
  }
  if (!ownsLease) {
    client.close();
    await session.close();
    return { processed: 0, warmRunner: true };
  }
  let leaseActive = true;
  let leaseClosing = false;
  let heartbeatPromise: Promise<void> = Promise.resolve();
  let activeTurn: { messageId: string; claimToken: string } | null = null;
  let activeTurnAbort: AbortController | null = null;
  const leaseAbort = new AbortController();
  const heartbeat = setInterval(() => {
    if (leaseClosing) return;
    heartbeatPromise = heartbeatPromise.catch(() => undefined).then(async () => {
      if (leaseClosing) return;
      const stillOwner = await convexMutation("chatQueue:touchRunner", {
        runnerId,
        activeMessageId: activeTurn?.messageId,
        claimToken: activeTurn?.claimToken,
      }).catch(() => true);
      if (stillOwner === false) {
        leaseActive = false;
        abortForegroundLeaseWork(leaseAbort, activeTurnAbort);
      }
    });
  }, 10_000);
  let handoffStarted = false;
  let handoffPromise: Promise<unknown> | null = null;
  const startHandoff = () => {
    if (handoffStarted) return;
    handoffStarted = true;
    const successorTask = taskForForegroundLane(successorLane(lane));
    handoffPromise = tasks.trigger(
      successorTask,
      { source: "warm-handoff" },
      { idempotencyKey: `jarvis-warm-${lane}-${runnerId}` },
    ).catch(() => null);
  };
  const handoffTimer = setTimeout(startHandoff, HANDOFF_AFTER_MS);

  const started = Date.now();
  const timings: ForegroundTurnTiming[] = [];
  let processed = 0;
  try {
  while (leaseActive && Date.now() - started < RUN_BUDGET_MS) {
    // Never claim work we cannot truthfully finish and deliver. Leaving it
    // pending makes it immediately eligible for the prewarmed successor.
    if (!canClaimForegroundTurn(RUN_BUDGET_MS - (Date.now() - started))) {
      startHandoff();
      break;
    }
    const claimStarted = Date.now();
    const exactTargetMessageId = targetMessageId;
    const claimToken = randomUUID();
    const claim = (targetMessageId
      ? await convexMutation("chatQueue:claimMessage", { messageId: targetMessageId, claimToken })
      : await convexMutation("chatQueue:claimNext", { claimToken })) as QueueClaim | null;
    const claimedAt = Date.now();
    if (!claim) {
      targetMessageId = undefined;
      if (exactTargetMessageId) break;
      const remaining = RUN_BUDGET_MS - (Date.now() - started) - FOREGROUND_ADMISSION_RESERVE_MS;
      if (remaining <= 0 || !(await waitForPending(
        client,
        workerToken,
        Math.min(remaining, FOREGROUND_IDLE_TIMEOUT_MS),
        leaseAbort.signal,
      ))) break;
      continue;
    }
    if (claim.guest) {
      await convexMutation("chatQueue:finalize", {
        messageId: claim.assistantId,
        threadId: claim.threadId,
        status: "error",
        finalText: "This expired browser session is no longer available. Reload Jarvis and resend.",
        claimToken: claim.claimToken,
      }).catch(() => {});
      targetMessageId = undefined;
      continue;
    }
    activeTurn = { messageId: claim.assistantId, claimToken: claim.claimToken };
    const cancellationAbort = new AbortController();
    activeTurnAbort = cancellationAbort;
    const stopCancellationWatch = client.onUpdate(
      api.chatQueue.turnCancellationForWorker,
      {
        messageId: claim.assistantId,
        claimToken: claim.claimToken,
        workerToken,
      },
      (cancelled) => { if (cancelled) cancellationAbort.abort(); },
      () => undefined,
    );
    try {
      const visibleUserText = visibleTurnText(claim.userText);
      const contextStarted = Date.now();
      const contextPromise = buildContext(visibleUserText);
      const imageInputsPromise = materializeCodexChatImages(claim.userText, claim.attachments, {
        signal: cancellationAbort.signal,
      });
      // Context snapshots and private image reads are independent. Image turns
      // should pay the slower branch, not the sum of both branches.
      const [baseContext, imageInputs] = await Promise.all([contextPromise, imageInputsPromise]);
      const fileContext = buildBoundedFileContext(claim.attachments);
      const fileCatalog = buildBoundedThreadFileCatalog(claim.fileCatalog);
      const researchContext = claim.researchPrefetch
        && claim.researchPrefetch.expiresAt > Date.now()
        && isSpeculativeResearchApplicable(claim.researchPrefetch.basis, visibleUserText)
          ? claim.researchPrefetch.context
          : "";
      const context = [baseContext, researchContext, fileCatalog, fileContext].filter(Boolean).join("\n\n");
      const contextReadyAt = Date.now();
      const model = pickConversationTier(visibleUserText);
      const stages: Partial<Record<"codexAck" | "firstDelta" | "firstConvexPaint", number>> = {};
      // Luna-tier turns get their own lightweight Codex thread (see
      // lunaFastPreamble above) so a cold runner's first greeting doesn't pay
      // for the full conversation preamble. Attachments/owner-tool grants stay
      // on the richer main thread unconditionally — those never come from a
      // trivial greeting in practice, and this leaves their existing behavior
      // (including the private-file thread-forgetting below) untouched.
      const lunaFastLane = model === "luna" && claim.attachments.length === 0 && !claim.ownerToolAccess;
      const codexConversationId = lunaFastLane ? `${claim.threadId}::luna-fast` : claim.threadId;
      const turn = await session.runTurn((activeServer, onStarted) => runTurn(
        activeServer,
        codexConversationId,
        claim.assistantId,
        claim.claimToken,
        claim.userText,
        claim.history,
        context,
        imageInputs,
        model,
        claim.attachments.length > 0,
        {
          requestId: claim.requestId,
          userMessageId: claim.userMessageId,
        },
        claim.ownerToolAccess
          ? {
            foregroundOwnerToolTurn: {
              messageId: String(claim.userMessageId),
              assistantId: String(claim.assistantId),
              claimToken: claim.claimToken,
            },
          }
          : undefined,
        cancellationAbort,
        (stage) => {
          if (stage === "codexAck") onStarted();
          if (stages[stage] === undefined) stages[stage] = Date.now();
        },
      ));
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
        claimToken: claim.claimToken,
      });
      const deliveredAt = Date.now();
      // Memory capture is a separate background task. It must never hold the
      // warm conversational worker hostage after Daniel already has a reply.
      if (turn.finalText.trim() && shouldCaptureDurableMemory(visibleUserText)) void tasks.trigger("jarvis-chat-memory", {
        userText: visibleUserText,
        assistantText: turn.finalText,
        sourceMessageId: targetMessageId ? String(targetMessageId) : undefined,
      }).catch(() => {});
      timings.push({
        claimMs: claimedAt - claimStarted,
        contextMs: contextReadyAt - contextStarted,
        codexAckMs: stages.codexAck ? stages.codexAck - contextReadyAt : undefined,
        firstDeltaMs: stages.firstDelta ? stages.firstDelta - contextReadyAt : undefined,
        firstConvexPaintMs: stages.firstConvexPaint ? stages.firstConvexPaint - contextReadyAt : undefined,
        completionMs: modelFinishedAt - contextReadyAt,
        finalizeMs: deliveredAt - finalizeStarted,
        deliveredMs: deliveredAt - claimStarted,
      });
      if (timings.length > 12) timings.shift();
      processed += 1;
      // Realtime metadata is deliberately per delivered turn, never per token.
      // It contains only durations and lets the active run be monitored before
      // its eventual four-hour cleanup path executes.
      metadata.set("foregroundTiming", buildForegroundTiming(timings, Date.now() - started, lane));
      await metadata.flush();
    } catch (error: unknown) {
      await convexMutation("chatQueue:finalize", {
        messageId: claim.assistantId,
        threadId: claim.threadId,
        status: "error",
        finalText: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
        claimToken: claim.claimToken,
      }).catch(() => {});
    } finally {
      stopCancellationWatch();
      if (activeTurnAbort === cancellationAbort) activeTurnAbort = null;
    }
    activeTurn = null;
    // After its exact wake-up message, retain this authenticated CLI process
    // and drain rapid follow-ups. Duplicate queued wake tasks become no-ops.
    targetMessageId = undefined;
  }
    return { processed, timings };
  } finally {
    // A final structured snapshot records the bounded timing state even when
    // the worker exits through its cleanup path rather than a delivered turn.
    try {
      metadata.set("foregroundTiming", buildForegroundTiming(timings, Date.now() - started, lane));
      await metadata.flush();
    } finally {
      leaseClosing = true;
      abortForegroundLeaseWork(
        leaseAbort,
        activeTurnAbort,
        new Error("foreground runner retiring"),
      );
      clearInterval(heartbeat);
      clearTimeout(handoffTimer);
      await heartbeatPromise.catch(() => undefined);
      await handoffPromise;
      const retirement = await convexMutation("chatQueue:releaseRunner", { runnerId })
        .catch(() => null) as {
          released?: boolean;
          pendingMessageId?: string | null;
          pendingThreadId?: string | null;
          pendingDispatchEpoch?: number | null;
        } | null;
      if (
        retirement?.released
        && retirement.pendingMessageId
        && retirement.pendingThreadId
        && Number.isSafeInteger(retirement.pendingDispatchEpoch)
        && (retirement.pendingDispatchEpoch as number) >= 0
      ) {
        // Admission raced the realtime listener's final timeout. The atomic
        // retirement receipt transfers responsibility to one replacement wake;
        // this path is exceptional and adds no task to ordinary warm turns.
        await tasks.trigger(
          taskForForegroundLane(lane),
          {
            messageId: retirement.pendingMessageId,
            threadId: retirement.pendingThreadId,
            dispatchEpoch: retirement.pendingDispatchEpoch,
            source: "runner-retirement",
          },
          { idempotencyKey: `jarvis-retire-${retirement.pendingMessageId}` },
        ).catch(() => null);
      }
      await session.close();
      client.close();
    }
  }
}

export const chatMemory = task({
  id: "jarvis-chat-memory",
  queue: { name: "jarvis-memory", concurrencyLimit: 2 },
  machine: "small-1x",
  maxDuration: 180,
  run: async (payload: { userText: string; assistantText: string; sourceMessageId?: string }) => {
    const provider: AgentProvider = "codex";
    const prepared = await prepareSubscriptionEnv(provider, {
      scope: "memory",
      minimumValidityMs: MEMORY_SUBSCRIPTION_VALIDITY_MS,
    });
    try {
      const bin = resolveSubscriptionAgentBin(provider);
      if (prepared.error || !bin) return { saved: 0, error: prepared.error ?? "Codex binary unavailable" };
      const preflight = verifyCodexSubscriptionPreflight(bin, prepared.env);
      if (preflight.error) return { saved: 0, error: preflight.error };
      return { saved: await extractAndSave(provider, bin, prepared.env, payload.userText, payload.assistantText, payload.sourceMessageId) };
    } finally {
      cleanupSubscriptionHome(prepared.env);
    }
  },
});;

// Initial and recovery turns enter the primary lane. Its owner prewarms the
// alternate lane only at the four-hour handoff boundary.
export const chatTurn = task({
  id: "jarvis-chat-turn",
  retry: { maxAttempts: 1 },
  queue: { name: FOREGROUND_QUEUE, concurrencyLimit: FOREGROUND_CONCURRENCY },
  machine: "small-1x",
  maxDuration: FOREGROUND_LANE_MAX_DURATION_SECONDS,
  onFailure: async ({ payload }) => {
    await settleUnclaimedForegroundStartupFailure(payload);
  },
  run: async (payload: ForegroundTurnPayload) => processChatQueue(payload, "primary"),
});

// The alternate lane is always prewarmed by the primary lane, and then
// prewarms the primary lane on its own handoff. Its queue is unoccupied while
// the primary lane owns the authoritative Convex lease.
export const chatHandoff = task({
  id: "jarvis-chat-handoff",
  retry: { maxAttempts: 1 },
  queue: { name: "jarvis-foreground-handoff", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: FOREGROUND_LANE_MAX_DURATION_SECONDS,
  onFailure: async ({ payload }) => {
    await settleUnclaimedForegroundStartupFailure(payload);
  },
  run: async (payload: ForegroundTurnPayload) => processChatQueue({ ...payload, source: "warm-handoff" }, "handoff"),
});

// Recovery lane only: if an immediate trigger is lost between Vercel and
// Trigger, the next schedule drains the durable Convex queue.
export const chatDispatcher = schedules.task({
  id: "jarvis-chat-dispatcher",
  // A lost Trigger response remains ambiguous, so it is recovered durably
  // rather than terminally failed. Keep that bounded wait to one minute.
  cron: "*/1 * * * *",
  queue: { name: "jarvis-foreground-recovery", concurrencyLimit: 1 },
  maxDuration: 60,
  run: async () => {
    const reaped = await convexCall("mutation", "chatQueue:reapStuck", {})
      .catch(() => ({ requeued: 0, failed: 0 })) as { requeued?: number; failed?: number };
    const [lease, pendingMessageId] = await Promise.all([
      convexCall("query", "chatQueue:runnerLeaseForWorker", {}) as Promise<{ updatedAt?: number } | null>,
      convexCall("query", "chatQueue:pendingSignal", {}) as Promise<{ messageId?: string; threadId?: string } | null>,
    ]);
    const warm = Boolean(lease?.updatedAt && Date.now() - lease.updatedAt < 25_000);
    if (warm) return { warm: true, pending: Boolean(pendingMessageId), reaped };
    if (!pendingMessageId?.messageId || !pendingMessageId.threadId) return { warm: false, pending: false, reaped };
    const recovery = await dispatchPendingForegroundRecovery({
      messageId: pendingMessageId.messageId,
      threadId: pendingMessageId.threadId,
    }, {
      requestRecovery: async ({ messageId, threadId }) => await convexCall(
        "mutation",
        "chatQueue:requestRecovery",
        { messageId, threadId },
      ),
      trigger: async (messageId, dispatchEpoch) => {
        const handle = await tasks.trigger(
          "jarvis-chat-turn",
          { source: "recovery", messageId, threadId: pendingMessageId.threadId, dispatchEpoch },
          { idempotencyKey: `jarvis-recovery-${messageId}-${dispatchEpoch}` },
        );
        return { id: handle.id };
      },
    });
    return { warm: false, pending: true, reaped, ...recovery };
  },
});
