import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { codexModelFor } from "./model-policy";
import { appendAgentMessageDelta } from "./codex-stream";

type JsonObject = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type ConversationHistoryItem = { role: "user" | "assistant"; text: string };
type ConversationState = {
  threadId: string;
  modelTier: string;
  history: ConversationHistoryItem[];
  lastUsedAt: number;
};
type TurnEvent = { message: JsonObject; receivedAt: number; bytes: number };
type BufferedTurnEvents = {
  events: TurnEvent[];
  bytes: number;
  firstReceivedAt: number;
  overflowed: boolean;
};
type ActiveTurn = {
  turnId: string;
  threadId: string;
  conversationId: string;
  userText: string;
  text: string;
  itemId?: string;
  onDelta: (delta: string) => void;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  serverReadyAt: number;
  conversationReadyAt: number;
  turnAcceptedAt: number;
  firstEventAt?: number;
  firstDeltaAt?: number;
  firstDeltaBuffered: boolean;
  bufferedEventCount: number;
};

const MAX_HANDOFF_CONVERSATIONS = 2;
const MAX_CONVERSATIONS = 8;
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_ITEM_CHARS = 4_000;
const MAX_HISTORY_CHARS = 24_000;
const MAX_ACTIVE_TURNS = 8;
const MAX_PENDING_REQUESTS = 32;
const MAX_TURN_TEXT_CHARS = 120_000;
const MAX_BUFFERED_TURNS = MAX_ACTIVE_TURNS;
const MAX_BUFFERED_EVENTS_PER_TURN = 512;
const MAX_BUFFERED_BYTES_PER_TURN = 512 * 1024;
const BUFFERED_EVENT_TTL_MS = 35_000;
const MAX_SETTLED_TURN_IDS = 64;

export type CodexTurnTiming = {
  appServerReadyMs: number;
  conversationReadyMs: number;
  turnResponseMs: number;
  firstDeltaMs: number | null;
  generationMs: number;
  modelCompletedMs: number;
  totalMs: number;
  bufferedEventCount: number;
  firstDeltaBeforeTurnResponse: boolean;
};
export type CodexTurnResult = {
  finalText: string;
  threadId: string;
  code: number;
  stderr: string;
  timing: CodexTurnTiming;
};
export type CodexConversationHandoff = {
  conversationId: string;
  modelTier: string;
  history: ConversationHistoryItem[];
};
export type CodexDynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonObject;
};
export type CodexDynamicToolCall = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};
export type CodexDynamicToolResult = {
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
  success: boolean;
};
export type CodexAppServerOptions = {
  dynamicTools?: CodexDynamicToolSpec[];
  onDynamicToolCall?: (call: CodexDynamicToolCall) => Promise<CodexDynamicToolResult>;
  now?: () => number;
};
export type CodexTurnInput = {
  conversationId: string;
  turnKey?: string;
  userText: string;
  history: Array<{ role: string; text: string }>;
  contextBlock: string;
  turnDirective?: string;
  preamble: string;
  modelTier: string;
  onDelta: (delta: string) => void;
};

function boundedHistory(history: Array<{ role: string; text: string }>): ConversationHistoryItem[] {
  const newestFirst = history
    .filter((item) => item.role === "user" || item.role === "assistant")
    .map((item) => ({
      role: item.role as ConversationHistoryItem["role"],
      text: String(item.text ?? "").trim().slice(0, MAX_HISTORY_ITEM_CHARS),
    }))
    .filter((item) => item.text)
    .slice(-MAX_HISTORY_ITEMS)
    .reverse();
  const kept: ConversationHistoryItem[] = [];
  let chars = 0;
  for (const item of newestFirst) {
    if (chars + item.text.length > MAX_HISTORY_CHARS) continue;
    kept.unshift(item);
    chars += item.text.length;
  }
  return kept;
}

function responseItems(history: ConversationHistoryItem[]): JsonObject[] {
  return history.map((item) => ({
    type: "message",
    role: item.role,
    content: [{
      type: item.role === "user" ? "input_text" : "output_text",
      text: item.text,
    }],
  }));
}

function sameHistoryItem(left: ConversationHistoryItem, right: ConversationHistoryItem) {
  return left.role === right.role && left.text === right.text;
}

function endsWithHistory(
  history: ConversationHistoryItem[],
  suffix: ConversationHistoryItem[],
) {
  if (suffix.length > history.length) return false;
  const offset = history.length - suffix.length;
  return suffix.every((item, index) => sameHistoryItem(history[offset + index], item));
}

function historyOverlap(
  existing: ConversationHistoryItem[],
  incoming: ConversationHistoryItem[],
) {
  for (let size = Math.min(existing.length, incoming.length); size > 0; size -= 1) {
    const offset = existing.length - size;
    if (incoming.slice(0, size).every((item, index) => sameHistoryItem(existing[offset + index], item))) {
      return size;
    }
  }
  return 0;
}

// One long-lived subscription CLI process for foreground conversation. The
// app-server protocol keeps authenticated threads warm and emits real deltas.
export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private active = new Map<string, ActiveTurn>();
  private conversations = new Map<string, ConversationState>();
  private conversationStarts = new Map<string, Promise<ConversationState>>();
  private earlyTurnEvents = new Map<string, BufferedTurnEvents>();
  private droppedEarlyTurnIds = new Set<string>();
  private settledTurnIds = new Set<string>();
  private turnStartsInFlight = 0;
  private stderr = "";
  private ready: Promise<void> | null = null;

  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly turnTimeoutMs: number,
    private readonly options: CodexAppServerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (!this.ready) this.ready = this.startInner();
    return this.ready;
  }

  private async startInner() {
    const child = spawn(this.bin, ["app-server", "--listen", "stdio://"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.on("data", (data) => { this.stderr = (this.stderr + data.toString()).slice(-1200); });
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => this.failAll(new Error(`Codex app-server exited (${code ?? "unknown"})`)));
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    await this.request("initialize", {
      clientInfo: { name: "jarvis-trigger", title: "Jarvis", version: "1.0.0" },
      // Dynamic tools and thread/inject_items are experimental in the pinned
      // 0.144.5 protocol, so the foreground client opts into that exact schema.
      capabilities: { experimentalApi: true },
    }, 20_000);
    this.notify("initialized", {});
  }

  async prewarmConversations(
    handoffs: CodexConversationHandoff[],
    preamble: string,
  ): Promise<number> {
    await this.start();
    let warmed = 0;
    for (const handoff of handoffs.slice(0, MAX_HANDOFF_CONVERSATIONS)) {
      if (!handoff.conversationId || this.conversations.has(handoff.conversationId)) continue;
      try {
        await this.ensureConversation(
          handoff.conversationId,
          preamble,
          handoff.modelTier,
          handoff.history,
        );
        warmed += 1;
      } catch {
        // The worker is still useful when a persisted handoff is unavailable:
        // its first claimed turn will create a fresh, history-seeded thread.
        this.conversations.delete(handoff.conversationId);
      }
    }
    return warmed;
  }

  handoffConversations(limit = 1): CodexConversationHandoff[] {
    return [...this.conversations.entries()]
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
      .slice(0, Math.min(Math.max(0, limit), MAX_HANDOFF_CONVERSATIONS))
      .map(([conversationId, state]) => ({
        conversationId,
        modelTier: state.modelTier,
        history: boundedHistory(state.history),
      }));
  }

  async runTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
    const startedAt = this.now();
    await this.start();
    const serverReadyAt = this.now();
    let conversation = await this.ensureConversation(
      input.conversationId,
      input.preamble,
      input.modelTier,
      input.history,
    );
    conversation = await this.syncConversationHistory(
      input.conversationId,
      conversation,
      input.preamble,
      input.modelTier,
      input.history,
    );
    conversation.modelTier = input.modelTier;
    conversation.lastUsedAt = this.now();
    const conversationReadyAt = this.now();
    const selection = codexModelFor(input.modelTier);
    const marker = input.userText.match(/\[JARVIS_IMAGE_URL:([^\]]+)\]/);
    const cleanText = input.userText.replace(/\s*\[JARVIS_IMAGE_URL:[^\]]+\]\s*/g, " ").trim();
    const userInput: JsonObject[] = [{ type: "text", text: cleanText }];
    if (marker?.[1]) userInput.push({ type: "image", url: marker[1].trim(), detail: "high" });
    const additionalContext: JsonObject = {};
    if (input.contextBlock.trim()) {
      additionalContext["jarvis-live-context"] = { value: input.contextBlock, kind: "application" };
    }
    if (input.turnDirective?.trim()) {
      additionalContext["jarvis-turn-guidance"] = { value: input.turnDirective, kind: "application" };
    }

    if (this.active.size + this.turnStartsInFlight >= MAX_ACTIVE_TURNS) {
      throw new Error("Codex foreground turn concurrency exceeded its event handoff bound");
    }
    this.turnStartsInFlight += 1;
    let started: JsonObject;
    try {
      started = await this.request("turn/start", {
        threadId: conversation.threadId,
        clientUserMessageId: input.turnKey,
        input: userInput,
        additionalContext: Object.keys(additionalContext).length ? additionalContext : undefined,
        model: selection.model,
        effort: selection.effort,
        approvalPolicy: "never",
      }, 30_000);
    } finally {
      this.turnStartsInFlight -= 1;
    }
    const turnAcceptedAt = this.now();
    const turn = started.turn as JsonObject | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : "";
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    const buffered = this.takeEarlyTurnEvents(turnId);
    if (buffered?.overflowed) {
      try { this.notify("turn/interrupt", { threadId: conversation.threadId, turnId }); } catch { /* process ended */ }
      this.rememberSettledTurn(turnId);
      throw new Error("Codex early turn event handoff exceeded its deterministic bound");
    }

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const elapsed = Math.max(0, this.now() - conversationReadyAt);
      const timer = setTimeout(() => {
        try { this.notify("turn/interrupt", { threadId: conversation.threadId, turnId }); } catch { /* process ended */ }
        this.active.delete(turnId);
        this.rememberSettledTurn(turnId);
        reject(new Error("Codex conversation turn exceeded its foreground deadline"));
      }, Math.max(1, this.turnTimeoutMs - elapsed));
      this.active.set(turnId, {
        turnId,
        threadId: conversation.threadId,
        conversationId: input.conversationId,
        userText: cleanText,
        text: "",
        onDelta: input.onDelta,
        resolve,
        reject,
        timer,
        startedAt,
        serverReadyAt,
        conversationReadyAt,
        turnAcceptedAt,
        firstDeltaBuffered: false,
        bufferedEventCount: buffered?.events.length ?? 0,
      });
      for (const event of buffered?.events ?? []) {
        this.routeTurnNotification(event.message, event.receivedAt, false, true);
      }
    });
  }

  stop() {
    this.process?.kill("SIGTERM");
    this.process = null;
    this.earlyTurnEvents.clear();
    this.droppedEarlyTurnIds.clear();
  }

  private async ensureConversation(
    conversationId: string,
    preamble: string,
    modelTier: string,
    history: Array<{ role: string; text: string }>,
  ): Promise<ConversationState> {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    const starting = this.conversationStarts.get(conversationId);
    if (starting) return starting;
    this.pruneConversations(1);
    if (this.conversations.size + this.conversationStarts.size >= MAX_CONVERSATIONS) {
      throw new Error("Codex foreground conversation cache reached its deterministic bound");
    }
    const promise = this.startConversation(conversationId, preamble, modelTier, history);
    this.conversationStarts.set(conversationId, promise);
    try {
      return await promise;
    } finally {
      this.conversationStarts.delete(conversationId);
    }
  }

  private async syncConversationHistory(
    conversationId: string,
    conversation: ConversationState,
    preamble: string,
    modelTier: string,
    history: Array<{ role: string; text: string }>,
  ): Promise<ConversationState> {
    const incoming = boundedHistory(history);
    const existing = conversation.history;
    if (
      !incoming.length ||
      (existing.length > 0 && (endsWithHistory(existing, incoming) || endsWithHistory(incoming, existing)))
    ) {
      return conversation;
    }
    const overlap = historyOverlap(existing, incoming);
    if (!overlap && existing.length) {
      // A candidate may have prewarmed from an older rolling window. Starting
      // a fresh thread is safer than duplicating or reordering model history.
      this.conversations.delete(conversationId);
      return this.startConversation(conversationId, preamble, modelTier, incoming);
    }
    const missing = incoming.slice(overlap);
    if (missing.length) {
      await this.request("thread/inject_items", {
        threadId: conversation.threadId,
        items: responseItems(missing),
      }, 30_000);
      conversation.history = boundedHistory([...existing, ...missing]);
      conversation.lastUsedAt = this.now();
    }
    return conversation;
  }

  private async startConversation(
    conversationId: string,
    preamble: string,
    modelTier: string,
    history: Array<{ role: string; text: string }>,
  ): Promise<ConversationState> {
    const selection = codexModelFor(modelTier);
    const response = await this.request("thread/start", {
      model: selection.model,
      baseInstructions: preamble,
      developerInstructions: "Remain the foreground Jarvis conversation. Give the useful answer immediately. Delegate long work instead of blocking conversation.",
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      dynamicTools: this.options.dynamicTools,
    }, 30_000);
    const thread = response.thread as JsonObject | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : "";
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    const seededHistory = boundedHistory(history);
    if (seededHistory.length) {
      await this.request("thread/inject_items", {
        threadId,
        items: responseItems(seededHistory),
      }, 30_000);
    }
    const state = { threadId, modelTier, history: seededHistory, lastUsedAt: this.now() };
    this.conversations.set(conversationId, state);
    this.pruneConversations();
    return state;
  }

  private pruneConversations(reserve = 0) {
    const activeConversationIds = new Set([...this.active.values()].map((turn) => turn.conversationId));
    while (this.conversations.size + reserve > MAX_CONVERSATIONS) {
      const oldest = [...this.conversations.entries()]
        .filter(([conversationId]) => !activeConversationIds.has(conversationId))
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) break;
      this.conversations.delete(oldest[0]);
    }
  }

  private receive(line: string) {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    const method = typeof message.method === "string" ? message.method : "";
    if (
      method === "item/tool/call" &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      void this.respondToDynamicToolCall(message);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(this.errorText(message.error)));
      else pending.resolve((message.result as JsonObject | undefined) ?? {});
      return;
    }
    this.routeTurnNotification(message, this.now(), true, false, Buffer.byteLength(line, "utf8"));
  }

  private routeTurnNotification(
    message: JsonObject,
    receivedAt: number,
    allowBuffer: boolean,
    buffered: boolean,
    bytes = 0,
  ) {
    const method = typeof message.method === "string" ? message.method : "";
    if (!this.isTurnLifecycleMethod(method)) return;
    const params = (message.params as JsonObject | undefined) ?? {};
    const turn = params.turn as JsonObject | undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : "";
    if (!turnId || this.settledTurnIds.has(turnId)) return;
    const active = this.active.get(turnId);
    if (!active) {
      if (allowBuffer && this.turnStartsInFlight > 0) {
        this.bufferEarlyTurnEvent(turnId, { message, receivedAt, bytes });
      }
      return;
    }
    const notificationThreadId = typeof params.threadId === "string" ? params.threadId : "";
    if (notificationThreadId && notificationThreadId !== active.threadId) return;
    active.firstEventAt ??= receivedAt;
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      if (active.text.length + params.delta.length + 2 > MAX_TURN_TEXT_CHARS) {
        this.rejectActiveTurn(active, "Codex foreground answer exceeded its deterministic bound");
        return;
      }
      const next = appendAgentMessageDelta({ text: active.text, itemId: active.itemId }, params.delta, itemId);
      active.text = next.state.text;
      active.itemId = next.state.itemId;
      if (active.firstDeltaAt === undefined) {
        active.firstDeltaAt = receivedAt;
        active.firstDeltaBuffered = buffered;
      }
      try {
        active.onDelta(next.emitted);
      } catch {
        this.rejectActiveTurn(active, "Codex foreground stream consumer failed");
      }
    } else if (method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (!active.text && item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.text.length > MAX_TURN_TEXT_CHARS) {
          this.rejectActiveTurn(active, "Codex foreground answer exceeded its deterministic bound");
          return;
        }
        active.text = item.text;
        active.firstDeltaAt ??= receivedAt;
        active.firstDeltaBuffered ||= buffered;
        try {
          active.onDelta(item.text);
        } catch {
          this.rejectActiveTurn(active, "Codex foreground stream consumer failed");
        }
      }
    } else if (method === "turn/completed") {
      const status = typeof turn?.status === "string" ? turn.status : "failed";
      clearTimeout(active.timer);
      this.active.delete(turnId);
      this.rememberSettledTurn(turnId);
      if (status === "completed" && active.text) {
        const conversation = this.conversations.get(active.conversationId);
        if (conversation?.threadId === active.threadId) {
          conversation.history = boundedHistory([
            ...conversation.history,
            { role: "user", text: active.userText },
            { role: "assistant", text: active.text },
          ]);
          conversation.lastUsedAt = this.now();
        }
      }
      const resultAt = this.now();
      const firstDeltaAt = active.firstDeltaAt;
      active.resolve({
        finalText: active.text,
        threadId: active.threadId,
        code: status === "completed" ? 0 : -1,
        stderr: status === "completed" ? "" : this.errorText(turn?.error ?? status),
        timing: {
          appServerReadyMs: this.duration(active.startedAt, active.serverReadyAt),
          conversationReadyMs: this.duration(active.serverReadyAt, active.conversationReadyAt),
          turnResponseMs: this.duration(active.conversationReadyAt, active.turnAcceptedAt),
          firstDeltaMs: firstDeltaAt === undefined ? null : this.duration(active.conversationReadyAt, firstDeltaAt),
          generationMs: this.duration(firstDeltaAt ?? active.conversationReadyAt, receivedAt),
          modelCompletedMs: this.duration(active.conversationReadyAt, receivedAt),
          totalMs: this.duration(active.startedAt, resultAt),
          bufferedEventCount: active.bufferedEventCount,
          firstDeltaBeforeTurnResponse: active.firstDeltaBuffered,
        },
      });
    }
  }

  private isTurnLifecycleMethod(method: string) {
    return method === "turn/started" ||
      method === "item/agentMessage/delta" ||
      method === "item/completed" ||
      method === "turn/completed";
  }

  private bufferEarlyTurnEvent(turnId: string, event: TurnEvent) {
    this.sweepEarlyTurnEvents(event.receivedAt);
    let bucket = this.earlyTurnEvents.get(turnId);
    if (!bucket) {
      if (this.earlyTurnEvents.size >= MAX_BUFFERED_TURNS) {
        this.rememberDroppedEarlyTurn(turnId);
        return;
      }
      bucket = { events: [], bytes: 0, firstReceivedAt: event.receivedAt, overflowed: false };
      this.earlyTurnEvents.set(turnId, bucket);
    }
    const eventBytes = event.bytes || JSON.stringify(event.message).length;
    if (
      bucket.events.length >= MAX_BUFFERED_EVENTS_PER_TURN ||
      bucket.bytes + eventBytes > MAX_BUFFERED_BYTES_PER_TURN
    ) {
      bucket.overflowed = true;
      return;
    }
    bucket.events.push({ ...event, bytes: eventBytes });
    bucket.bytes += eventBytes;
  }

  private takeEarlyTurnEvents(turnId: string): BufferedTurnEvents | undefined {
    this.sweepEarlyTurnEvents(this.now());
    const buffered = this.earlyTurnEvents.get(turnId);
    this.earlyTurnEvents.delete(turnId);
    if (this.droppedEarlyTurnIds.delete(turnId)) {
      return buffered ?? { events: [], bytes: 0, firstReceivedAt: this.now(), overflowed: true };
    }
    return buffered;
  }

  private sweepEarlyTurnEvents(now: number) {
    for (const [turnId, bucket] of this.earlyTurnEvents) {
      if (now - bucket.firstReceivedAt > BUFFERED_EVENT_TTL_MS) this.earlyTurnEvents.delete(turnId);
    }
  }

  private rememberSettledTurn(turnId: string) {
    this.settledTurnIds.delete(turnId);
    this.settledTurnIds.add(turnId);
    while (this.settledTurnIds.size > MAX_SETTLED_TURN_IDS) {
      const oldest = this.settledTurnIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.settledTurnIds.delete(oldest);
    }
  }

  private rememberDroppedEarlyTurn(turnId: string) {
    this.droppedEarlyTurnIds.delete(turnId);
    this.droppedEarlyTurnIds.add(turnId);
    while (this.droppedEarlyTurnIds.size > MAX_BUFFERED_TURNS) {
      const oldest = this.droppedEarlyTurnIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.droppedEarlyTurnIds.delete(oldest);
    }
  }

  private rejectActiveTurn(active: ActiveTurn, message: string) {
    clearTimeout(active.timer);
    this.active.delete(active.turnId);
    this.rememberSettledTurn(active.turnId);
    try { this.notify("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }); } catch { /* process ended */ }
    active.reject(new Error(message));
  }

  private async respondToDynamicToolCall(message: JsonObject) {
    const params = (message.params as JsonObject | undefined) ?? {};
    const handler = this.options.onDynamicToolCall;
    let dynamicResult: CodexDynamicToolResult;
    if (!handler || typeof params.tool !== "string") {
      dynamicResult = {
        contentItems: [{ type: "inputText", text: "Jarvis dynamic tool bridge is unavailable." }],
        success: false,
      };
    } else {
      try {
        dynamicResult = await handler({
          threadId: typeof params.threadId === "string" ? params.threadId : "",
          turnId: typeof params.turnId === "string" ? params.turnId : "",
          callId: typeof params.callId === "string" ? params.callId : "",
          namespace: typeof params.namespace === "string" ? params.namespace : null,
          tool: params.tool,
          arguments: params.arguments,
        });
      } catch {
        dynamicResult = {
          contentItems: [{ type: "inputText", text: "Jarvis dynamic tool bridge failed inside its host." }],
          success: false,
        };
      }
    }
    try {
      this.write({ id: message.id, result: dynamicResult });
    } catch {
      // The process may have ended while the host request was active.
    }
  }

  private request(method: string, params: JsonObject, timeoutMs: number): Promise<JsonObject> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Codex app-server request concurrency exceeded its deterministic bound"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private notify(method: string, params: JsonObject) { this.write({ method, params }); }
  private write(message: JsonObject) {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not writable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private errorText(value: unknown): string {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value).slice(0, 500); } catch { return String(value).slice(0, 500); }
  }
  private failAll(error: Error) {
    const detail = new Error(`${error.message}${this.stderr ? `: ${this.stderr.slice(-400)}` : ""}`);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(detail); }
    this.pending.clear();
    for (const active of this.active.values()) { clearTimeout(active.timer); active.reject(detail); }
    this.active.clear();
    this.earlyTurnEvents.clear();
    this.droppedEarlyTurnIds.clear();
    this.conversationStarts.clear();
  }
  private now() { return this.options.now?.() ?? performance.now(); }
  private duration(start: number, end: number) { return Math.max(0, Math.round(end - start)); }
}
