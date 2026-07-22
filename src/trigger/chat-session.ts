import { metadata, schedules, task, tasks } from "@trigger.dev/sdk/v3";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { CAPABILITIES, INFRA_MAP, PERSONA, REMEMBER } from "../lib/persona";
import { visualInitiativeDirective } from "../lib/visual-initiative";
import { visibleTurnText } from "../lib/host-context";
import { buildContext } from "../lib/context";
import { codexModelFor, codexReviewExecPrefix, pickConversationTier } from "./model-policy";
import {
  consumeSubscriptionAuth,
  isCodexUnauthorizedError,
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
  FOREGROUND_LANE_MAX_DURATION_SECONDS,
  FOREGROUND_MAX_DURATION_SECONDS,
  FOREGROUND_PROCESS_EXIT_RESERVE_MS,
  FOREGROUND_QUEUE,
  FOREGROUND_RUNNER_LEASE_MS,
  FOREGROUND_TURN_TIMEOUT_MS,
  type ForegroundTurnPayload,
} from "./foreground-policy";
import { waitForForegroundLease } from "./foreground-lease";
import { successorLane, taskForForegroundLane, type ForegroundLane } from "./foreground-lanes";
import { buildForegroundTiming, type ForegroundTurnTiming } from "./foreground-timing";
import { CodexAppServer } from "./codex-app-server";
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
      (messageId) => { if (messageId) finish(true); },
      () => finish(false),
    );
  });
}

type QueueClaim = {
  threadId: string;
  guest?: boolean;
  userText: string;
  assistantId: string;
  history: Array<{ role: string; text: string }>;
};

function conversationPreamble(guest = false) {
  if (guest) {
    return `${PERSONA}\n\nYou are speaking with an unpaired guest. Keep this conversation isolated: do not access or mention Daniel's memory, projects, work, files, panels, capabilities, or other conversations. Do not call tools, create artifacts, or perform actions. Give a helpful conversational answer only.`;
  }
  return PERSONA +
    `\n\n${CAPABILITIES}\n\n${INFRA_MAP}\n\n${REMEMBER}\n\n` +
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
  guest: boolean,
  onStage?: (stage: "codexAck" | "firstDelta" | "firstConvexPaint") => void,
){
  const publisher = new StreamPublisher(
    (text, revision) => convexMutation("chatQueue:updateStream", { messageId: assistantId, text, revision }),
    120,
    () => onStage?.("firstConvexPaint"),
  );
  publisher.start();
  try {
    const visualDirective = guest ? "" : visualInitiativeDirective(visibleTurnText(userText));
    const freshContext = `${contextBlock}\n\nCurrent date: ${new Date().toDateString()}.` +
      (visualDirective ? `\n\n${visualDirective}` : "");
    let sawDelta = false;
    const result = await server.runTurn({
      conversationId,
      userText,
      history,
      contextBlock: freshContext,
      preamble: conversationPreamble(guest),
      modelTier: model,
      allowTools: !guest,
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
    await publisher.close();
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
): Promise<number> {
  const prompt =
    "From the exchange below, extract ONLY durable facts, preferences, decisions, or tasks worth " +
    "remembering long-term about Daniel or his projects. Output STRICT JSON: an array of " +
    '{"kind","title","body","tags"} where kind is one of fact|preference|decision|task|project. ' +
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
  if (!dispatchToken) return { processed: 0, error: "JARVIS_DISPATCH_TOKEN is not configured" };
  let prepared = await prepareSubscriptionEnv(provider, {
    scope: `foreground-${lane}`,
    minimumValidityMs: FOREGROUND_TURN_TIMEOUT_MS + 2 * 60_000,
  });
  if (prepared.error) return { processed: 0, error: prepared.error };
  let env = prepared.env;
  const bin = resolveSubscriptionAgentBin(provider);
  if (!bin) return { processed: 0, error: `${provider} binary not found` };
  const preflight = verifyCodexSubscriptionPreflight(bin, env);
  if (preflight.error) return { processed: 0, error: preflight.error };
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  if (!workerToken) return { processed: 0, error: "JARVIS_WORKER_TOKEN is not configured" };
  const runnerId = randomUUID();
  const bridge = new AgentToolBridge(dispatchToken);
  const createServer = (serverEnv: NodeJS.ProcessEnv) => new CodexAppServer(bin, serverEnv, FOREGROUND_TURN_TIMEOUT_MS, {
      dynamicTools: JARVIS_DYNAMIC_TOOLS,
      dynamicToolsOnly: true,
      onDynamicToolCall: (call) => bridge.invoke(call),
      onAuthConsumed: () => consumeSubscriptionAuth(serverEnv),
    });
  let server = createServer(env);
  const client = new ConvexClient(CONVEX_URL);
  // A handoff candidate pays startup cost inside the bounded overlap, but
  // never takes ownership from a still-serving runner.
  if (source === "warm-handoff") await server.start();
  const ownsLease = source === "warm-handoff"
    ? await waitForRunnerAvailability(client, workerToken, runnerId, FOREGROUND_HANDOFF_OVERLAP_MS + FOREGROUND_RUNNER_LEASE_MS)
    : await convexMutation("chatQueue:touchRunner", { runnerId }) as boolean;
  if (!ownsLease) {
    client.close();
    server.stop();
    return { processed: 0, warmRunner: true };
  }
  let leaseActive = true;
  const leaseAbort = new AbortController();
  const heartbeat = setInterval(() => void convexMutation("chatQueue:touchRunner", { runnerId })
    .then((stillOwner) => {
      if (stillOwner === false) {
        leaseActive = false;
        leaseAbort.abort();
      }
    })
    .catch(() => {}), 10_000);
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
    // Prewarm even when the scheduled recovery task found no message. This is
    // the always-available main Jarvis, separate from durable specialist work.
    await server.start();
  while (leaseActive && Date.now() - started < RUN_BUDGET_MS) {
    // Never claim work we cannot truthfully finish and deliver. Leaving it
    // pending makes it immediately eligible for the prewarmed successor.
    if (!canClaimForegroundTurn(RUN_BUDGET_MS - (Date.now() - started))) {
      startHandoff();
      break;
    }
    const claimStarted = Date.now();
    const claim = (targetMessageId
      ? await convexMutation("chatQueue:claimMessage", { messageId: targetMessageId })
      : await convexMutation("chatQueue:claimNext", {})) as QueueClaim | null;
    const claimedAt = Date.now();
    if (!claim) {
      targetMessageId = undefined;
      const remaining = RUN_BUDGET_MS - (Date.now() - started) - FOREGROUND_ADMISSION_RESERVE_MS;
      if (remaining <= 0 || !(await waitForPending(client, workerToken, remaining, leaseAbort.signal))) break;
      continue;
    }
    try {
      const visibleUserText = visibleTurnText(claim.userText);
      const contextStarted = Date.now();
      const context = claim.guest
        ? "No private context is available for a guest conversation."
        : await buildContext(visibleUserText);
      const contextReadyAt = Date.now();
      const model = pickConversationTier(visibleUserText);
      const stages: Partial<Record<"codexAck" | "firstDelta" | "firstConvexPaint", number>> = {};
      const executeTurn = () => runTurn(
          server,
          claim.threadId,
          claim.assistantId,
          claim.userText,
          claim.history,
          context,
          model,
          Boolean(claim.guest),
          (stage) => { if (stages[stage] === undefined) stages[stage] = Date.now(); },
        );
      const renewUnauthorizedSession = async () => {
        if (prepared.snapshotVersion === undefined) throw new Error("Codex subscription snapshot version is unavailable");
        const renewed = await prepareSubscriptionEnv(provider, {
          scope: `foreground-${lane}-unauthorized`,
          minimumValidityMs: FOREGROUND_TURN_TIMEOUT_MS + 2 * 60_000,
          afterUnauthorizedVersion: prepared.snapshotVersion,
        });
        if (renewed.error) throw new Error(renewed.error);
        const renewedPreflight = verifyCodexSubscriptionPreflight(bin, renewed.env);
        if (renewedPreflight.error) throw new Error(renewedPreflight.error);
        server.stop();
        prepared = renewed;
        env = renewed.env;
        server = createServer(env);
      };
      let turn;
      let retriedUnauthorized = false;
      try {
        turn = await executeTurn();
      } catch (error) {
        if (!isCodexUnauthorizedError(error) || prepared.snapshotVersion === undefined) throw error;
        // A consumer never retries a refresh token. Ask the fenced controller
        // for a snapshot newer than the one that received 401, restart only
        // this app-server, and replay the still-claimed turn exactly once.
        await renewUnauthorizedSession();
        retriedUnauthorized = true;
        turn = await executeTurn();
      }
      if (!retriedUnauthorized && turn.code !== 0 && isCodexUnauthorizedError(turn.stderr)) {
        await renewUnauthorizedSession();
        retriedUnauthorized = true;
        turn = await executeTurn();
      }
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
      if (!claim.guest && turn.finalText.trim()) void tasks.trigger("jarvis-chat-memory", {
        userText: visibleUserText,
        assistantText: turn.finalText,
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
      }).catch(() => {});
    }
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
      clearInterval(heartbeat);
      clearTimeout(handoffTimer);
      if (!handoffStarted && leaseActive) startHandoff();
      await handoffPromise;
      client.close();
      server.stop();
      await convexMutation("chatQueue:releaseRunner", { runnerId }).catch(() => {});
    }
  }
}

export const chatMemory = task({
  id: "jarvis-chat-memory",
  queue: { name: "jarvis-memory", concurrencyLimit: 2 },
  machine: "small-1x",
  maxDuration: 180,
  run: async (payload: { userText: string; assistantText: string }) => {
    const provider: AgentProvider = "codex";
    const prepared = await prepareSubscriptionEnv(provider, { scope: "memory" });
    const bin = resolveSubscriptionAgentBin(provider);
    if (prepared.error || !bin) return { saved: 0, error: prepared.error ?? "Codex binary unavailable" };
    const preflight = verifyCodexSubscriptionPreflight(bin, prepared.env);
    if (preflight.error) return { saved: 0, error: preflight.error };
    return { saved: await extractAndSave(provider, bin, prepared.env, payload.userText, payload.assistantText) };
  },
});

// Initial and recovery turns enter the primary lane. Its owner prewarms the
// alternate lane only at the four-hour handoff boundary.
export const chatTurn = task({
  id: "jarvis-chat-turn",
  queue: { name: FOREGROUND_QUEUE, concurrencyLimit: FOREGROUND_CONCURRENCY },
  machine: "small-1x",
  maxDuration: FOREGROUND_LANE_MAX_DURATION_SECONDS,
  run: async (payload: ForegroundTurnPayload) => processChatQueue(payload, "primary"),
});

// The alternate lane is always prewarmed by the primary lane, and then
// prewarms the primary lane on its own handoff. Its queue is unoccupied while
// the primary lane owns the authoritative Convex lease.
export const chatHandoff = task({
  id: "jarvis-chat-handoff",
  queue: { name: "jarvis-foreground-handoff", concurrencyLimit: 1 },
  machine: "small-1x",
  maxDuration: FOREGROUND_LANE_MAX_DURATION_SECONDS,
  run: async (payload: ForegroundTurnPayload) => processChatQueue({ ...payload, source: "warm-handoff" }, "handoff"),
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
