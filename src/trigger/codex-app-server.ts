import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { codexAppServerArgs, codexModelFor } from "./model-policy";
import { appendAgentMessageDelta } from "./codex-stream";
import { spawnCodex } from "./codex-launcher";

type JsonObject = Record<string, unknown>;
type PendingRequest = { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type ActiveTurn = {
  turnId: string;
  threadId: string;
  text: string;
  itemId?: string;
  onDelta: (delta: string) => void;
  resolve: (result: CodexTurnResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexTurnResult = { finalText: string; threadId: string; code: number; stderr: string };
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
  boundedRuntimeMs?: number;
};
export type CodexTurnInput = {
  conversationId: string;
  userText: string;
  history: Array<{ role: string; text: string }>;
  contextBlock: string;
  preamble: string;
  modelTier: string;
  onDelta: (delta: string) => void;
};

// One long-lived subscription CLI process for foreground conversation. The
// app-server protocol keeps authenticated threads warm and emits real deltas.
export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private active = new Map<string, ActiveTurn>();
  private threads = new Map<string, string>();
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
    const child = spawnCodex({
      mode: "foreground",
      command: this.bin,
      args: codexAppServerArgs(),
      cwd: String(this.env.CODEX_HOME),
      env: this.env,
      boundedRuntimeMs: this.options.boundedRuntimeMs ?? this.turnTimeoutMs,
    }, { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.on("data", (data) => { this.stderr = (this.stderr + data.toString()).slice(-1200); });
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => this.failAll(new Error(`Codex app-server exited (${code ?? "unknown"})`)));
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    await this.request("initialize", {
      clientInfo: { name: "jarvis-trigger", title: "Jarvis", version: "1.0.0" },
      // Dynamic tools are experimental in the pinned 0.144.5 protocol. This
      // capability is required for thread/start.dynamicTools.
      capabilities: { experimentalApi: true },
    }, 20_000);
    this.notify("initialized", {});
  }

  async runTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
    await this.start();
    const selection = codexModelFor(input.modelTier);
    let threadId = this.threads.get(input.conversationId);
    const isNewThread = !threadId;
    if (!threadId) {
      const response = await this.request("thread/start", {
        model: selection.model,
        baseInstructions: input.preamble,
        developerInstructions: "Remain the foreground Jarvis conversation. Give the useful answer immediately. Delegate long work instead of blocking conversation.",
        cwd: "/tmp",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        dynamicTools: this.options.dynamicTools,
      }, 30_000);
      const thread = response.thread as JsonObject | undefined;
      threadId = typeof thread?.id === "string" ? thread.id : "";
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      this.threads.set(input.conversationId, threadId);
    }

    const history = isNewThread && input.history.length
      ? `Recent conversation:\n${input.history.map((item) => `${item.role === "user" ? "Daniel" : "Jarvis"}: ${item.text}`).join("\n")}\n\n`
      : "";
    const marker = input.userText.match(/\[JARVIS_IMAGE_URL:([^\]]+)\]/);
    const cleanText = input.userText.replace(/\s*\[JARVIS_IMAGE_URL:[^\]]+\]\s*/g, " ").trim();
    const text = `${history}Current live context (use only what is relevant):\n${input.contextBlock}\n\nDaniel: ${cleanText}`;
    const userInput: JsonObject[] = [{ type: "text", text }];
    if (marker?.[1]) userInput.push({ type: "image", url: marker[1].trim(), detail: "high" });
    const started = await this.request("turn/start", {
      threadId,
      input: userInput,
      model: selection.model,
      effort: selection.effort,
      approvalPolicy: "never",
    }, 30_000);
    const turn = started.turn as JsonObject | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : "";
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notify("turn/interrupt", { threadId, turnId });
        this.active.delete(turnId);
        reject(new Error("Codex conversation turn exceeded its foreground deadline"));
      }, this.turnTimeoutMs);
      this.active.set(turnId, { turnId, threadId, text: "", onDelta: input.onDelta, resolve, reject, timer });
    });
  }

  stop() { this.process?.kill("SIGTERM"); this.process = null; }

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
    const params = (message.params as JsonObject | undefined) ?? {};
    const turn = params.turn as JsonObject | undefined;
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn?.id === "string" ? turn.id : "";
    const active = this.active.get(turnId);
    if (!active) return;
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const next = appendAgentMessageDelta({ text: active.text, itemId: active.itemId }, params.delta, itemId);
      active.text = next.state.text;
      active.itemId = next.state.itemId;
      active.onDelta(next.emitted);
    } else if (method === "item/completed") {
      const item = params.item as JsonObject | undefined;
      if (!active.text && item?.type === "agentMessage" && typeof item.text === "string") {
        active.text = item.text;
        active.onDelta(item.text);
      }
    } else if (method === "turn/completed") {
      const status = typeof turn?.status === "string" ? turn.status : "failed";
      clearTimeout(active.timer);
      this.active.delete(turnId);
      active.resolve({ finalText: active.text, threadId: active.threadId, code: status === "completed" ? 0 : -1, stderr: status === "completed" ? "" : this.errorText(turn?.error ?? status) });
    }
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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params });
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
  }
}
