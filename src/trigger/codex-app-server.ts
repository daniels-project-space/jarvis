import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { codexModelFor } from "./model-policy";
import { appendAgentMessageDelta } from "./codex-stream";
import { redactSensitiveText } from "../lib/secret-redaction";
import { BoundedJsonLineDecoder } from "../lib/bounded-json-lines";
import { hasExactKeys, isJsonRecord, parseStrictJson } from "../lib/bounded-json";

type JsonObject = Record<string, unknown>;
type PendingRequest = {
  method: string;
  written: boolean;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
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
export type CodexPermissionProfileOptions = {
  id: string;
  config: JsonObject;
  environments: [];
  runtimeWorkspaceRoots: string[];
  expected: {
    activePermissionProfileId: string;
    sandbox: { type: "readOnly"; networkAccess: false };
  };
};
export type CodexAppServerOptions = {
  dynamicTools?: CodexDynamicToolSpec[];
  onDynamicToolCall?: (call: CodexDynamicToolCall) => Promise<CodexDynamicToolResult>;
  controllerCwd?: string;
  threadSandbox?: "danger-full-access" | "read-only" | "workspace-write";
  permissionProfile?: CodexPermissionProfileOptions;
  developerInstructions?: string;
  ephemeral?: boolean;
  onAuthConsumed?: () => void;
  dynamicToolsOnly?: boolean;
};

const APP_SERVER_MAX_LINE_BYTES = 2 * 1_024 * 1_024;
const APP_SERVER_STDERR_MAX_BYTES = 1_200;
const CHATGPT_PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "business",
  "enterprise_cbp_usage_based", "enterprise", "edu", "unknown",
]);

export class CodexRequestRejectedError extends Error {
  readonly code = "codex_request_rejected";
  readonly provenPreStartRejection = true;
  constructor(readonly method: string, detail: string) {
    super(`${method} rejected${detail ? `: ${detail}` : ""}`);
    this.name = "CodexRequestRejectedError";
  }
}

export class CodexRequestOutcomeUnknownError extends Error {
  readonly code = "codex_request_outcome_unknown";
  readonly replaySafe = false;
  constructor(readonly method: string) {
    super(`${method} outcome is unknown after protocol write`);
    this.name = "CodexRequestOutcomeUnknownError";
  }
}

export function verifyCodexInitializeResult(value: unknown, expectedCodexHome: string): void {
  if (!isJsonRecord(value)
    || !hasExactKeys(value, ["codexHome", "platformFamily", "platformOs", "userAgent"])
    || typeof value.codexHome !== "string" || resolve(value.codexHome) !== resolve(expectedCodexHome)
    || value.platformFamily !== "unix" || value.platformOs !== "linux"
    || typeof value.userAgent !== "string" || value.userAgent.length > 512
    || !/0\.144\.5(?:\D|$)/.test(value.userAgent)) {
    throw new Error("Codex app-server initialize attestation failed");
  }
}

export function verifyCodexAccountReadResult(value: unknown): void {
  if (!isJsonRecord(value)
    || !hasExactKeys(value, ["account", "requiresOpenaiAuth"])
    || value.requiresOpenaiAuth !== true || !isJsonRecord(value.account)
    || !hasExactKeys(value.account, ["type", "email", "planType"])
    || value.account.type !== "chatgpt"
    || !(value.account.email === null
      || (typeof value.account.email === "string" && value.account.email.length <= 320))
    || typeof value.account.planType !== "string" || !CHATGPT_PLAN_TYPES.has(value.account.planType)) {
    throw new Error("Codex app-server ChatGPT account attestation failed");
  }
}

function validProtocolError(value: unknown): boolean {
  return isJsonRecord(value)
    && hasExactKeys(value, ["code", "message"], ["data"])
    && Number.isSafeInteger(value.code)
    && typeof value.message === "string"
    && value.message.length <= 1_024;
}

export class CodexPermissionAttestationError extends Error {
  readonly code = "permission_attestation_failed";
  readonly disposition = "blocked";

  constructor(message: string) {
    super(message);
    this.name = "CodexPermissionAttestationError";
  }
}

export function verifyCodexPermissionAttestation(
  response: JsonObject,
  expected: CodexPermissionProfileOptions["expected"],
): void {
  const active = response.activePermissionProfile as JsonObject | undefined;
  const sandbox = response.sandbox as JsonObject | undefined;
  if (active?.id !== expected.activePermissionProfileId) {
    throw new CodexPermissionAttestationError("Codex thread did not activate the required permission profile");
  }
  if (sandbox?.type !== expected.sandbox.type || sandbox?.networkAccess !== expected.sandbox.networkAccess) {
    throw new CodexPermissionAttestationError("Codex thread did not attest the required read-only, network-denied sandbox");
  }
}
export type CodexTurnInput = {
  conversationId: string;
  userText: string;
  history: Array<{ role: string; text: string }>;
  contextBlock: string;
  preamble: string;
  modelTier: string;
  allowTools?: boolean;
  onDelta: (delta: string) => void;
  /** Durable receipt written before turn/start may cross the protocol. */
  beforeTurn?: () => Promise<void>;
  onTurnRequestWritten?: () => void;
  onTurnAccepted?: () => Promise<void>;
  onTurnStarted?: () => void;
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
  private authConsumed = false;

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
    const child = spawn(this.bin, ["app-server", "--listen", "stdio://"], {
      env: this.env,
      cwd: this.options.controllerCwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stderr.on("data", (data) => {
      const tail = data.toString().slice(-APP_SERVER_STDERR_MAX_BYTES);
      this.stderr = (this.stderr + redactSensitiveText(tail, this.env)).slice(-APP_SERVER_STDERR_MAX_BYTES);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("close", (code) => this.failAll(new Error(`Codex app-server exited (${code ?? "unknown"})`)));
    const decoder = new BoundedJsonLineDecoder(APP_SERVER_MAX_LINE_BYTES);
    child.stdout.on("data", (data: Buffer) => {
      try {
        for (const message of decoder.push(data)) this.receiveMessage(message);
      } catch {
        this.protocolFailure();
      }
    });
    child.stdout.once("end", () => {
      try { decoder.finish(); } catch { this.protocolFailure(); }
    });
    const initialized = await this.request("initialize", {
      clientInfo: { name: "jarvis-trigger", title: "Jarvis", version: "1.0.0" },
      // Dynamic tools are experimental in the pinned 0.144.5 protocol. This
      // capability is required for thread/start.dynamicTools.
      capabilities: { experimentalApi: true },
    }, 20_000);
    verifyCodexInitializeResult(initialized, String(this.env.CODEX_HOME ?? ""));
    this.notify("initialized", {});
    const account = await this.request("account/read", { refreshToken: false }, 20_000);
    verifyCodexAccountReadResult(account);
  }

  async runTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
    await this.start();
    const selection = codexModelFor(input.modelTier);
    let threadId = this.threads.get(input.conversationId);
    const isNewThread = !threadId;
    if (!threadId) {
      const permissionProfile = this.options.permissionProfile;
      let response: JsonObject;
      try {
        response = await this.request("thread/start", {
          model: selection.model,
          baseInstructions: input.preamble,
          developerInstructions: this.options.developerInstructions ?? "Remain the foreground Jarvis conversation. Give the useful answer immediately. Delegate long work instead of blocking conversation.",
          cwd: this.options.controllerCwd ?? "/tmp",
          approvalPolicy: "never",
          ...(permissionProfile ? {
            permissions: permissionProfile.id,
            config: permissionProfile.config,
            environments: permissionProfile.environments,
            runtimeWorkspaceRoots: permissionProfile.runtimeWorkspaceRoots,
          } : {
            sandbox: this.options.threadSandbox ?? "danger-full-access",
            ...(this.options.dynamicToolsOnly ? {
              config: {
                web_search: "disabled",
                shell_environment_policy: { inherit: "none" },
                features: {
                  shell_tool: false,
                  unified_exec: false,
                  apps: false,
                  plugins: false,
                  hooks: false,
                  browser_use: false,
                  computer_use: false,
                  multi_agent: false,
                },
              },
              environments: [],
            } : {}),
          }),
          ephemeral: this.options.ephemeral ?? false,
          dynamicTools: input.allowTools === false ? [] : this.options.dynamicTools,
        }, 30_000);
      } catch (error) {
        if (permissionProfile) {
          throw new CodexPermissionAttestationError("Codex thread permission attestation was unavailable");
        }
        throw error;
      }
      if (permissionProfile) verifyCodexPermissionAttestation(response, permissionProfile.expected);
      const thread = response.thread as JsonObject | undefined;
      threadId = typeof thread?.id === "string" ? thread.id : "";
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      this.threads.set(input.conversationId, threadId);
    }

    const speaker = input.allowTools === false ? "Guest" : "Daniel";
    const history = isNewThread && input.history.length
      ? `Recent conversation:\n${input.history.map((item) => `${item.role === "user" ? speaker : "Jarvis"}: ${item.text}`).join("\n")}\n\n`
      : "";
    const marker = input.userText.match(/\[JARVIS_IMAGE_URL:([^\]]+)\]/);
    const cleanText = input.userText.replace(/\s*\[JARVIS_IMAGE_URL:[^\]]+\]\s*/g, " ").trim();
    // Thread instructions hold static identity and policy. Fresh context is
    // deliberately present only in this one turn item so a cold thread does
    // not pay for the same snapshot in both protocol fields.
    const text = `${history}Current live context (use only what is relevant):\n${input.contextBlock}\n\n${speaker}: ${cleanText}`;
    const userInput: JsonObject[] = [{ type: "text", text }];
    if (marker?.[1]) userInput.push({ type: "image", url: marker[1].trim(), detail: "high" });
    await input.beforeTurn?.();
    const started = await this.request("turn/start", {
      threadId,
      input: userInput,
      model: selection.model,
      effort: selection.effort,
      approvalPolicy: "never",
    }, 30_000, input.onTurnRequestWritten);
    const turn = started.turn as JsonObject | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : "";
    if (!turnId) throw new Error("Codex app-server did not return a turn id");
    if (input.onTurnAccepted) await input.onTurnAccepted();
    if (!this.authConsumed) {
      this.authConsumed = true;
      this.options.onAuthConsumed?.();
    }
    input.onTurnStarted?.();
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
    if (Buffer.byteLength(line, "utf8") > APP_SERVER_MAX_LINE_BYTES) {
      this.protocolFailure();
      return;
    }
    try { this.receiveMessage(parseStrictJson(line)); }
    catch { this.protocolFailure(); }
  }

  private receiveMessage(value: unknown) {
    if (!isJsonRecord(value)) throw new Error("invalid app-server message");
    const message = value as JsonObject;
    const method = typeof message.method === "string" ? message.method : "";
    if (
      method === "item/tool/call" &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      if (!hasExactKeys(message, ["id", "method", "params"]) || !isJsonRecord(message.params)) {
        throw new Error("invalid tool request envelope");
      }
      void this.respondToDynamicToolCall(message);
      return;
    }
    if (typeof message.id === "number") {
      const responseShape = hasExactKeys(message, ["id", "result"])
        || hasExactKeys(message, ["id", "error"]);
      if (!responseShape) throw new Error("invalid response envelope");
      if (Object.prototype.hasOwnProperty.call(message, "error") && !validProtocolError(message.error)) {
        throw new Error("invalid response error");
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        pending.reject(new CodexRequestRejectedError(pending.method, this.errorText(message.error)));
      } else if (!isJsonRecord(message.result)) {
        pending.reject(new Error(`${pending.method} returned an invalid result`));
      } else pending.resolve(message.result);
      return;
    }
    if (!method || !hasExactKeys(message, ["method", "params"]) || !isJsonRecord(message.params)) {
      throw new Error("invalid notification envelope");
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

  private request(
    method: string,
    params: JsonObject,
    timeoutMs: number,
    onWritten?: () => void,
  ): Promise<JsonObject> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        written: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(pending.written
            ? new CodexRequestOutcomeUnknownError(method)
            : new Error(`${method} timed out before protocol write`));
        }, timeoutMs),
      };
      this.pending.set(id, pending);
      try {
        this.write({ method, id, params });
        pending.written = true;
        onWritten?.();
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(`${method} write failed`));
      }
    });
  }
  private notify(method: string, params: JsonObject) { this.write({ method, params }); }
  private write(message: JsonObject) {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server is not writable");
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > APP_SERVER_MAX_LINE_BYTES) {
      throw new Error("Codex app-server request is oversized");
    }
    this.process.stdin.write(encoded);
  }
  private errorText(value: unknown): string {
    if (typeof value === "string") return redactSensitiveText(value, this.env).slice(0, 500);
    try { return redactSensitiveText(JSON.stringify(value), this.env).slice(0, 500); }
    catch { return redactSensitiveText(String(value), this.env).slice(0, 500); }
  }
  private failAll(error: Error) {
    const detail = new Error(`${error.message}${this.stderr ? `: ${this.stderr.slice(-400)}` : ""}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.written ? new CodexRequestOutcomeUnknownError(pending.method) : detail);
    }
    this.pending.clear();
    for (const active of this.active.values()) { clearTimeout(active.timer); active.reject(detail); }
    this.active.clear();
  }

  private protocolFailure(): void {
    this.failAll(new Error("Codex app-server protocol validation failed"));
    try { this.process?.kill("SIGKILL"); } catch { /* already stopped */ }
  }
}
