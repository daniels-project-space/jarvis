import type {
  CodexDynamicToolCall,
  CodexDynamicToolResult,
  CodexDynamicToolSpec,
} from "./codex-app-server";
import type { ToolInvocationContext } from "../lib/tool-invocation-context";

export const JARVIS_AGENT_TOOL_ENDPOINT = "https://jarvis-orcin-six.vercel.app/api/agent-tool";

const TOOL_BELTS = ["core", "work", "creative", "travel", "business"] as const;

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
    description: "Load the slim Jarvis tool definitions for one capability belt before choosing a tool.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        belt: {
          type: "string",
          enum: [...TOOL_BELTS],
          description: "The capability belt to load.",
        },
      },
      required: ["belt"],
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
  "Call jarvis_get_tools with only the belt needed (core, work, creative, travel, or business), then call " +
  "jarvis_call_tool with an exact returned tool name and matching JSON args. Read the returned result and continue. " +
  "Use tools whenever Daniel asks you to show, make, change, search, remember, schedule, monitor, chart, plan travel, " +
  "or delegate—never merely claim it happened. The host owns bridge authentication; never ask for, inspect, or expose " +
  "credentials. You cannot approve consequential work; Daniel does that in the command deck.";

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type AgentToolBridgeOptions = {
  endpoint?: string;
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
  searchAttachedFiles?: (messageId: string, request: {
    mode: "search" | "read";
    query?: string;
    fileId?: string;
    afterOrdinal?: number;
  }) => Promise<unknown>;
  authorizeTool?: (messageId: string, toolName: string) => Promise<{ allowed: boolean; reason?: string }>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function result(text: string, success: boolean): CodexDynamicToolResult {
  return { contentItems: [{ type: "inputText", text }], success };
}

// Authentication stays in this Node host. The Codex child sees only two
// dynamic tools; it never receives the bearer or constructs a shell command.
export class AgentToolBridge {
  private readonly endpoint: URL;
  private readonly fetchImplementation: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly searchAttachedFiles?: AgentToolBridgeOptions["searchAttachedFiles"];
  private readonly authorizeTool?: AgentToolBridgeOptions["authorizeTool"];

  constructor(private readonly token: string, options: AgentToolBridgeOptions = {}) {
    if (!token) throw new Error("JARVIS_DISPATCH_TOKEN is not configured");
    this.endpoint = new URL(options.endpoint ?? JARVIS_AGENT_TOOL_ENDPOINT);
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.searchAttachedFiles = options.searchAttachedFiles;
    this.authorizeTool = options.authorizeTool;
  }

  async invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    if (call.namespace !== null) return result("Unknown Jarvis tool namespace.", false);
    if (call.tool === "jarvis_search_attached_files") {
      return this.searchFiles(call.arguments, call.invocationContext);
    }
    if (call.tool === "jarvis_get_tools") return this.getTools(call.arguments);
    if (call.tool === "jarvis_call_tool") return this.callTool(call.arguments, call.invocationContext);
    return result("Unknown Jarvis bridge tool.", false);
  }

  private async searchFiles(
    value: unknown,
    invocationContext?: ToolInvocationContext,
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
      return result("Attached-file search is unavailable for this turn.", false);
    }
    try {
      const found = await this.searchAttachedFiles(messageId, {
        mode,
        ...(query ? { query } : {}),
        ...(fileId ? { fileId } : {}),
        ...(afterOrdinal !== undefined ? { afterOrdinal } : {}),
      });
      return result(JSON.stringify(found).slice(0, 16_000) || "[]", true);
    } catch {
      return result("Attached-file search failed safely.", false);
    }
  }

  private async getTools(value: unknown): Promise<CodexDynamicToolResult> {
    const args = record(value);
    const belt = args?.belt;
    if (typeof belt !== "string" || !TOOL_BELTS.includes(belt as (typeof TOOL_BELTS)[number])) {
      return result("Invalid Jarvis tool belt.", false);
    }
    const url = new URL(this.endpoint);
    url.searchParams.set("belt", belt);
    return this.request(url, { method: "GET" });
  }

  private async callTool(
    value: unknown,
    invocationContext?: ToolInvocationContext,
  ): Promise<CodexDynamicToolResult> {
    const input = record(value);
    const name = input?.name;
    const args = record(input?.args);
    if (typeof name !== "string" || !name.trim() || !args) {
      return result("Invalid Jarvis tool call.", false);
    }
    const toolName = name.trim();
    if (this.authorizeTool) {
      const messageId = invocationContext?.userMessageId;
      if (!messageId) return result("This tool call has no trusted user-message provenance.", false);
      try {
        const authorization = await this.authorizeTool(messageId, toolName);
        if (!authorization.allowed) {
          return result("The original user message did not authorize this action.", false);
        }
      } catch {
        return result("Jarvis could not verify tool authorization, so the action was not run.", false);
      }
    }
    return this.request(new URL(this.endpoint), {
      method: "POST",
      body: JSON.stringify({
        name: toolName,
        args,
        ...(invocationContext ? { invocationContext } : {}),
      }),
    });
  }

  private async request(url: URL, init: { method: "GET" | "POST"; body?: string }): Promise<CodexDynamicToolResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
      };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const response = await this.fetchImplementation(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        // Never reflect an error body: a proxy must not echo authorization
        // material into the model transcript.
        return result(`Jarvis tool bridge rejected the request (HTTP ${response.status}).`, false);
      }
      return result((await response.text()) || "null", true);
    } catch {
      return result(
        controller.signal.aborted
          ? "Jarvis tool bridge request timed out."
          : "Jarvis tool bridge network request failed.",
        false,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
