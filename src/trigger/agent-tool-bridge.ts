import type {
  CodexDynamicToolCall,
  CodexDynamicToolHostContext,
  CodexDynamicToolResult,
  CodexDynamicToolSpec,
} from "./codex-app-server";
import type { ToolInvocationContext } from "../lib/tool-invocation-context";
import { rankCapabilities } from "../lib/capability-router";
import {
  issueForegroundOwnerToolReceipt,
  type ForegroundOwnerToolTurn,
} from "../lib/foreground-owner-tool-receipt.server";
import {
  FOREGROUND_OWNER_TOOL_NAMES,
  TOOL_BELT_NAMES,
  foregroundOwnerToolReceiptTarget,
  isForegroundOwnerToolName,
  isToolBeltName,
  type ToolBeltName,
} from "../lib/tool-belts";

export const JARVIS_AGENT_TOOL_ENDPOINT = "https://jarvis-orcin-six.vercel.app/api/agent-tool";
export const JARVIS_FOREGROUND_OWNER_TOOL_ENDPOINT = "https://jarvis-orcin-six.vercel.app/api/foreground-owner-tool";

type ForegroundOwnerToolHostTurn = NonNullable<
  CodexDynamicToolHostContext["foregroundOwnerToolTurn"]
>;

export const JARVIS_DYNAMIC_TOOLS: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "jarvis_search_attached_files",
    description: "Search or sequentially read only files attached to the current user message. Use search for specific evidence; use bounded read pages only when the user explicitly asks for whole-document analysis.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["search", "read"] },
        query: { type: "string", description: "Search terms; required in search mode." },
        fileId: { type: "string", description: "Attached file id; required in read mode, optional to narrow search." },
        afterOrdinal: { type: "number", description: "Read cursor returned by the previous read call; omit for the beginning." },
      },
      required: ["mode"],
    },
  },
  {
    type: "function",
    name: "jarvis_get_tools",
    description: "Route the current intent to the smallest relevant Jarvis capability set. Prefer intent; use belt only when the exact belt is already known.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: {
          type: "string",
          description: "Daniel's current request, copied closely enough for deterministic capability routing.",
        },
        belt: {
          type: "string",
          enum: [...TOOL_BELT_NAMES],
          description: "Optional exact capability belt; omit when intent is available.",
        },
        activeTool: {
          type: "string",
          description: "Exact tool used for the current visual, when this is a follow-up refinement.",
        },
      },
      anyOf: [{ required: ["intent"] }, { required: ["belt"] }],
    },
  },
  {
    type: "function",
    name: "jarvis_call_tool",
    description: "Call an exact Jarvis tool name with its JSON arguments after loading the relevant belt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "Exact tool name returned by jarvis_get_tools." },
        args: { type: "object", description: "Arguments matching that tool's input schema." },
      },
      required: ["name", "args"],
    },
  },
];

export const JARVIS_TOOL_INSTRUCTIONS =
  "FUNCTIONAL TOOLS: you can really act and render visuals through Jarvis's private native tool bridge. " +
  "For attached documents, use the excerpts already provided first; if key evidence is missing, call " +
  "jarvis_search_attached_files in search mode and cite the returned filename plus page, sheet, cell range, or chunk. " +
  "Use read mode and follow nextOrdinal only when Daniel explicitly asks to read or analyze the whole document. " +
  "Call jarvis_get_tools with intent set to Daniel's current request; its deterministic router returns only the smallest relevant definitions. " +
  `Use belt only when already certain (${TOOL_BELT_NAMES.join(", ")}); for a visual follow-up also pass activeTool. ` +
  "Then call jarvis_call_tool with an exact returned tool name and matching JSON args. Read the returned result and continue. " +
  "A request for a map, weather, search results, briefing, chart, writing surface, or planner must use the returned visual tool—never say you cannot display it. " +
  "Use tools whenever Daniel asks you to show, make, change, search, remember, schedule, monitor, chart, plan travel, " +
  "or delegate—never merely claim it happened. The host owns bridge authentication; never ask for, inspect, or expose " +
  "credentials. You cannot approve consequential work; Daniel does that in the command deck.";

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AgentToolBridgeFailureCode =
  | "invalid_request"
  | "authorization_denied"
  | "cancelled"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_response"
  | "upstream_failure";

export type AgentToolBridgeEvent = {
  operation: "discover" | "call";
  target: string;
  success: boolean;
  code: "ok" | AgentToolBridgeFailureCode;
  durationMs: number;
  status?: number;
};

export type AgentToolBridgeOptions = {
  endpoint?: string;
  ownerEndpoint?: string;
  /** Worker-only HMAC authority shared with the foreground-owner endpoint. */
  ownerToolReceiptSecret?: string;
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
  searchAttachedFiles?: (messageId: string, request: {
    mode: "search" | "read";
    query?: string;
    fileId?: string;
    afterOrdinal?: number;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  authorizeTool?: (messageId: string, toolName: string) => Promise<{ allowed: boolean; reason?: string }>;
  onEvent?: (event: AgentToolBridgeEvent) => void;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function result(text: string, success: boolean): CodexDynamicToolResult {
  return { contentItems: [{ type: "inputText", text }], success };
}

function failureResult(
  code: AgentToolBridgeFailureCode,
  message: string,
  details: { status?: number } = {},
): CodexDynamicToolResult {
  return result(JSON.stringify({
    ok: false,
    error: {
      code,
      message,
      ...(details.status !== undefined ? { status: details.status } : {}),
    },
  }), false);
}

function cancelledResult(): CodexDynamicToolResult {
  return failureResult("cancelled", "Jarvis tool bridge request was cancelled with its turn.");
}

function responseSignalsFailure(payload: unknown): boolean {
  const value = record(payload);
  if (!value) return false;
  if (value.ok === false || value.success === false) return true;
  if (value.error !== undefined && value.error !== null && value.error !== "") return true;

  const nested = record(value.result);
  if (nested && (nested.ok === false || nested.success === false || nested.error)) return true;
  const message = typeof value.result === "string"
    ? value.result
    : typeof value.message === "string"
      ? value.message
      : "";
  return /^(?:(?:tool|search|maps? key)\s+(?:failed|unavailable)|(?:travel map|weather)\s+lookup\s+failed|error|failed)(?:\s*:|\b)/i.test(message.trim());
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("turn cancelled"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("turn cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    if (signal.aborted) onAbort();
  });
}

// Authentication stays in this Node host. The Codex child sees only bounded
// dynamic tools; it never receives the bearer or constructs a shell command.
export class AgentToolBridge {
  private readonly endpoint: URL;
  private readonly ownerEndpoint: URL;
  private readonly ownerToolReceiptSecret?: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly searchAttachedFiles?: AgentToolBridgeOptions["searchAttachedFiles"];
  private readonly authorizeTool?: AgentToolBridgeOptions["authorizeTool"];
  private readonly onEvent?: AgentToolBridgeOptions["onEvent"];

  constructor(private readonly token: string, options: AgentToolBridgeOptions = {}) {
    if (!token) throw new Error("JARVIS_DISPATCH_TOKEN is not configured");
    this.endpoint = new URL(options.endpoint ?? JARVIS_AGENT_TOOL_ENDPOINT);
    this.ownerEndpoint = new URL(options.ownerEndpoint ?? JARVIS_FOREGROUND_OWNER_TOOL_ENDPOINT);
    this.ownerToolReceiptSecret = options.ownerToolReceiptSecret;
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.searchAttachedFiles = options.searchAttachedFiles;
    this.authorizeTool = options.authorizeTool;
    this.onEvent = options.onEvent;
  }

  private observe(event: AgentToolBridgeEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Observability must never change tool execution semantics.
    }
  }

  async invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    if (call.signal?.aborted) return cancelledResult();
    if (call.namespace !== null) return failureResult("invalid_request", "Unknown Jarvis tool namespace.");
    if (call.tool === "jarvis_search_attached_files") {
      return this.searchFiles(call.arguments, call.invocationContext, call.signal);
    }
    if (call.tool === "jarvis_get_tools") {
      return this.getTools(
        call.arguments,
        call.callId,
        call.toolHostContext,
        call.signal,
      );
    }
    if (call.tool === "jarvis_call_tool") {
      return this.callTool(
        call.arguments,
        call.invocationContext,
        call.callId,
        call.toolHostContext,
        call.signal,
      );
    }
    return failureResult("invalid_request", "Unknown Jarvis bridge tool.");
  }

  private async searchFiles(
    value: unknown,
    invocationContext?: ToolInvocationContext,
    signal?: AbortSignal,
  ): Promise<CodexDynamicToolResult> {
    const args = record(value);
    const mode = args?.mode === "read" ? "read" : args?.mode === "search" ? "search" : null;
    const query = typeof args?.query === "string" ? args.query.trim().slice(0, 240) : undefined;
    const fileId = typeof args?.fileId === "string" ? args.fileId.trim().slice(0, 120) : undefined;
    const afterOrdinal = typeof args?.afterOrdinal === "number" && Number.isSafeInteger(args.afterOrdinal)
      ? args.afterOrdinal
      : undefined;
    const messageId = invocationContext?.userMessageId;
    if (!mode || (mode === "search" && !query) || (mode === "read" && !fileId) || !messageId || !this.searchAttachedFiles) {
      return failureResult("invalid_request", "Attached-file search is unavailable for this turn.");
    }
    if (signal?.aborted) return cancelledResult();
    try {
      const found = await abortable(this.searchAttachedFiles(messageId, {
        mode,
        ...(query ? { query } : {}),
        ...(fileId ? { fileId } : {}),
        ...(afterOrdinal !== undefined ? { afterOrdinal } : {}),
        ...(signal ? { signal } : {}),
      }), signal);
      if (signal?.aborted) return cancelledResult();
      return result(JSON.stringify(found).slice(0, 16_000) || "[]", true);
    } catch {
      return signal?.aborted
        ? cancelledResult()
        : failureResult("upstream_failure", "Attached-file search failed safely.");
    }
  }

  private foregroundOwnerTurn(
    hostContext?: CodexDynamicToolHostContext,
  ): ForegroundOwnerToolHostTurn | null {
    const turn = hostContext?.foregroundOwnerToolTurn;
    return turn && this.ownerToolReceiptSecret ? turn : null;
  }

  private hasCalendarAndHubTodoScope(turn: ForegroundOwnerToolHostTurn | null): boolean {
    return Boolean(
      turn?.calendarAndHubTodo === true
      && turn.toolNames?.includes("google_calendar_create"),
    );
  }

  private async ownerRequest(
    turn: ForegroundOwnerToolTurn,
    callId: string,
    operation: "discover" | "invoke",
    target: string,
    init: { method: "GET" | "POST"; body?: string },
    metadata: Pick<AgentToolBridgeEvent, "operation" | "target">,
    signal?: AbortSignal,
  ): Promise<CodexDynamicToolResult | null> {
    try {
      const receipt = issueForegroundOwnerToolReceipt({
        secret: this.ownerToolReceiptSecret ?? "",
        turn,
        callId,
        operation,
        target,
      });
      const url = new URL(this.ownerEndpoint);
      if (operation === "discover") url.searchParams.set("belt", target);
      return await this.request(
        url,
        init,
        metadata,
        signal,
        { "x-jarvis-owner-tool-receipt": receipt },
      );
    } catch {
      // A malformed/missing host-only turn must not fall back to the ordinary
      // subscription bridge, which intentionally has no mailbox authority.
      return null;
    }
  }

  private async getTools(
    value: unknown,
    callId: string,
    hostContext?: CodexDynamicToolHostContext,
    signal?: AbortSignal,
  ): Promise<CodexDynamicToolResult> {
    const args = record(value);
    const intent = typeof args?.intent === "string" ? args.intent.trim().slice(0, 2_000) : "";
    const activeTool = typeof args?.activeTool === "string" ? args.activeTool.trim().slice(0, 120) : undefined;
    const explicitBelt = isToolBeltName(args?.belt) ? args.belt : undefined;
    const ownerTurn = this.foregroundOwnerTurn(hostContext);
    const ownerCalendarAndHubTodo = this.hasCalendarAndHubTodoScope(ownerTurn);
    const ranking = intent
      ? rankCapabilities(intent, {
        activeTool,
        ownerForeground: Boolean(ownerTurn),
        ownerToolNames: ownerTurn?.toolNames,
        ownerCalendarAndHubTodo,
      })
      : null;
    const belt: ToolBeltName | undefined = explicitBelt ?? ranking?.candidates[0]?.belt ?? (intent ? "core" : undefined);
    if (!belt) return failureResult("invalid_request", "Provide a valid Jarvis tool belt or the current intent.");

    const url = new URL(this.endpoint);
    url.searchParams.set("belt", belt);
    const response = await this.request(
      url,
      { method: "GET" },
      { operation: "discover", target: belt },
      signal,
    );
    if (!ranking) {
      // An explicit model-selected belt cannot bypass the admission scope.
      // Keep ordinary, hostless discovery unchanged, but remove Hub to-do
      // metadata from a Calendar-only owner turn before it reaches the model.
      if (!ownerTurn || ownerCalendarAndHubTodo || !response.success) return response;
      const text = response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "";
      try {
        const definitions = JSON.parse(text);
        if (!Array.isArray(definitions)) {
          return failureResult("invalid_response", "Jarvis tool discovery returned an invalid definition list.");
        }
        return result(JSON.stringify(definitions.filter((definition) => record(definition)?.name !== "todo_add")), true);
      } catch {
        return failureResult("invalid_response", "Jarvis tool discovery returned malformed JSON.");
      }
    }

    const ownerNames = ownerTurn
      ? ranking.candidates
        .filter((candidate) => candidate.belt === belt && FOREGROUND_OWNER_TOOL_NAMES.has(candidate.tool))
        .map((candidate) => candidate.tool)
      : [];
    const ownerResponse = ownerTurn && ownerNames.length
      ? await this.ownerRequest(
        ownerTurn,
        callId,
        "discover",
        belt,
        { method: "GET" },
        { operation: "discover", target: belt },
        signal,
      )
      : null;
    const successfulResponses = [response, ownerResponse]
      .filter((candidate): candidate is CodexDynamicToolResult => Boolean(candidate?.success));
    if (!successfulResponses.length) return ownerResponse ?? response;

    const definitions: unknown[] = [];
    for (const candidate of successfulResponses) {
      const text = candidate.contentItems[0]?.type === "inputText" ? candidate.contentItems[0].text : "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return failureResult("invalid_response", "Jarvis tool discovery returned malformed JSON.");
      }
      if (!Array.isArray(parsed)) {
        return failureResult("invalid_response", "Jarvis tool discovery returned an invalid definition list.");
      }
      definitions.push(...parsed);
    }

    const rankedNames = ranking.candidates
      .filter((candidate) => candidate.belt === belt)
      .map((candidate) => candidate.tool);
    const scopedDefinitions = ownerTurn && !ownerCalendarAndHubTodo
      ? definitions.filter((definition) => record(definition)?.name !== "todo_add")
      : definitions;
    const definitionsByName = new Map(scopedDefinitions.flatMap((definition) => {
      const candidate = record(definition);
      return typeof candidate?.name === "string" ? [[candidate.name, definition] as const] : [];
    }));
    const routedDefinitions = rankedNames.length > 0
      ? rankedNames.flatMap((name) => definitionsByName.has(name) ? [definitionsByName.get(name)] : [])
      : definitions;
    if (rankedNames.length > 0 && routedDefinitions.length === 0) {
      return failureResult("invalid_response", "The routed Jarvis capability is not present in the discovered belt.");
    }

    return result(JSON.stringify({
      belt,
      mustRender: ranking.explicitVisual || ranking.candidates.some((candidate) => candidate.belt === belt && candidate.visual),
      tools: routedDefinitions,
    }), true);
  }

  private async callTool(
    value: unknown,
    invocationContext?: ToolInvocationContext,
    callId?: string,
    hostContext?: CodexDynamicToolHostContext,
    signal?: AbortSignal,
  ): Promise<CodexDynamicToolResult> {
    const input = record(value);
    const name = input?.name;
    const args = record(input?.args);
    if (typeof name !== "string" || !name.trim() || !args) {
      return failureResult("invalid_request", "Invalid Jarvis tool call.");
    }
    const toolName = name.trim();
    if (signal?.aborted) return cancelledResult();
    const ownerTurn = this.foregroundOwnerTurn(hostContext);
    if (toolName === "todo_add" && ownerTurn && !this.hasCalendarAndHubTodoScope(ownerTurn)) {
      return failureResult("authorization_denied", "The original owner message did not authorize a Jarvis to-do addition.");
    }
    if (this.authorizeTool) {
      const messageId = invocationContext?.userMessageId;
      if (!messageId) return failureResult("authorization_denied", "This tool call has no trusted user-message provenance.");
      try {
        const authorization = await abortable(this.authorizeTool(messageId, toolName), signal);
        if (signal?.aborted) return cancelledResult();
        if (!authorization.allowed) {
          return failureResult("authorization_denied", "The original user message did not authorize this action.");
        }
      } catch {
        if (signal?.aborted) return cancelledResult();
        return failureResult("authorization_denied", "Jarvis could not verify tool authorization, so the action was not run.");
      }
    }
    if (isForegroundOwnerToolName(toolName)) {
      if (!ownerTurn || !callId) {
        return failureResult("authorization_denied", "This owner-only tool is unavailable outside its authenticated foreground turn.");
      }
      const receiptTarget = foregroundOwnerToolReceiptTarget(toolName, args);
      if (!receiptTarget) {
        return failureResult("invalid_request", "This foreground owner tool requires its exact approved arguments.");
      }
      const response = await this.ownerRequest(
        ownerTurn,
        callId,
        "invoke",
        receiptTarget,
        {
          method: "POST",
          // Provenance is reconstructed by the endpoint from the signed
          // host receipt. Never let model-supplied body context act as proof.
          body: JSON.stringify({ name: toolName, args }),
        },
        { operation: "call", target: toolName },
        signal,
      );
      return response ?? failureResult("authorization_denied", "Jarvis could not verify the owner foreground tool grant.");
    }
    return this.request(new URL(this.endpoint), {
      method: "POST",
      body: JSON.stringify({
        name: toolName,
        args,
        ...(invocationContext ? { invocationContext } : {}),
      }),
    }, { operation: "call", target: toolName }, signal);
  }

  private async request(
    url: URL,
    init: { method: "GET" | "POST"; body?: string },
    metadata: Pick<AgentToolBridgeEvent, "operation" | "target">,
    turnSignal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<CodexDynamicToolResult> {
    if (turnSignal?.aborted) return cancelledResult();
    const startedAt = Date.now();
    const finish = (
      success: boolean,
      code: AgentToolBridgeEvent["code"],
      status?: number,
    ) => this.observe({
      ...metadata,
      success,
      code,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(status !== undefined ? { status } : {}),
    });
    const controller = new AbortController();
    let timedOut = false;
    const abortFromTurn = () => controller.abort();
    turnSignal?.addEventListener("abort", abortFromTurn, { once: true });
    if (turnSignal?.aborted) abortFromTurn();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...extraHeaders,
        authorization: `Bearer ${this.token}`,
      };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const response = await abortable(this.fetchImplementation(url, {
        ...init,
        headers,
        signal: controller.signal,
      }), controller.signal);
      if (turnSignal?.aborted) return cancelledResult();
      if (!response.ok) {
        // Never reflect an error body: a proxy must not echo authorization
        // material into the model transcript.
        finish(false, "http_error", response.status);
        return failureResult(
          "http_error",
          `Jarvis tool bridge rejected the request (HTTP ${response.status}).`,
          { status: response.status },
        );
      }
      const text = await abortable(response.text(), controller.signal);
      if (turnSignal?.aborted) return cancelledResult();
      let payload: unknown;
      try {
        payload = JSON.parse(text || "null");
      } catch {
        finish(false, "invalid_response", response.status);
        return failureResult("invalid_response", "Jarvis tool bridge returned malformed JSON.");
      }
      if (responseSignalsFailure(payload)) {
        finish(false, "upstream_failure", response.status);
        return failureResult("upstream_failure", "Jarvis tool execution failed upstream.");
      }
      finish(true, "ok", response.status);
      return result(text || "null", true);
    } catch {
      if (turnSignal?.aborted) {
        finish(false, "cancelled");
        return cancelledResult();
      }
      const code = timedOut ? "timeout" : "network_error";
      finish(false, code);
      return failureResult(
        code,
        timedOut
          ? "Jarvis tool bridge request timed out."
          : "Jarvis tool bridge network request failed.",
      );
    } finally {
      clearTimeout(timeout);
      turnSignal?.removeEventListener("abort", abortFromTurn);
    }
  }
}
