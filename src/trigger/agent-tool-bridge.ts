import type {
  CodexDynamicToolCall,
  CodexDynamicToolResult,
  CodexDynamicToolSpec,
} from "./codex-app-server";

export const JARVIS_AGENT_TOOL_ENDPOINT = "https://jarvis-orcin-six.vercel.app/api/agent-tool";

const TOOL_BELTS = ["core", "work", "creative", "travel", "business"] as const;

export const JARVIS_DYNAMIC_TOOLS: CodexDynamicToolSpec[] = [
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

  constructor(private readonly token: string, options: AgentToolBridgeOptions = {}) {
    if (!token) throw new Error("JARVIS_DISPATCH_TOKEN is not configured");
    this.endpoint = new URL(options.endpoint ?? JARVIS_AGENT_TOOL_ENDPOINT);
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    if (call.namespace !== null) return result("Unknown Jarvis tool namespace.", false);
    if (call.tool === "jarvis_get_tools") return this.getTools(call.arguments);
    if (call.tool === "jarvis_call_tool") return this.callTool(call.arguments);
    return result("Unknown Jarvis bridge tool.", false);
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

  private async callTool(value: unknown): Promise<CodexDynamicToolResult> {
    const input = record(value);
    const name = input?.name;
    const args = record(input?.args);
    if (typeof name !== "string" || !name.trim() || !args) {
      return result("Invalid Jarvis tool call.", false);
    }
    return this.request(new URL(this.endpoint), {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), args }),
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
