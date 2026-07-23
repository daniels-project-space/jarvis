import type { CodexDynamicToolCall, CodexDynamicToolResult, CodexDynamicToolSpec } from "./codex-app-server";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  validateSandboxOutput,
  type CloudWorkspace,
  type CloudWorkspaceProvider,
} from "./cloud-workspace";

export const CLOUD_REPOSITORY_TOOLS: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "repository_exec",
    description: "Run one bounded command inside the isolated cloud repository workspace. No controller environment is inherited and network is denied by default.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 16_000 },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs },
      }, required: ["command"],
    },
  },
  {
    type: "function", name: "repository_read_file",
    description: "Read one bounded UTF-8 text file from the isolated cloud repository workspace.",
    inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1_000 } }, required: ["path"] },
  },
  {
    type: "function", name: "repository_write_file",
    description: "Write one bounded UTF-8 text file inside the isolated cloud repository workspace.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 1_000 }, content: { type: "string", maxLength: DEFAULT_WORKSPACE_LIMITS.maxFileBytes } },
      required: ["path", "content"],
    },
  },
  {
    type: "function", name: "repository_list_files",
    description: "List a bounded directory inside the isolated cloud repository workspace.",
    inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1_000 } }, required: ["path"] },
  },
];

type ToolBridgeOptions = {
  signal?: AbortSignal;
  beforeTool?: (call: CodexDynamicToolCall) => Promise<"running" | "stale" | "cancelled" | "steered">;
};

function result(text: string, success: boolean): CodexDynamicToolResult {
  return { contentItems: [{ type: "inputText", text }], success };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value as Record<string, unknown>;
}

export class CloudWorkspaceToolBridge {
  constructor(
    private readonly provider: CloudWorkspaceProvider,
    private readonly workspace: CloudWorkspace,
    private readonly options: ToolBridgeOptions = {},
  ) {}

  async invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    if (call.namespace !== null || !CLOUD_REPOSITORY_TOOLS.some((tool) => tool.name === call.tool)) {
      return result("Unknown cloud repository tool.", false);
    }
    try {
      const state = await this.options.beforeTool?.(call) ?? "running";
      if (state !== "running") throw new CloudWorkspaceError(this.provider.name, state === "cancelled" ? "cancelled" : "stale_attempt", `attempt is ${state}`, "deferred");
      const args = object(call.arguments);
      if (call.tool === "repository_exec") {
        const command = String(args.command ?? "");
        if (!command || command.length > 16_000) throw new Error("command is missing or oversized");
        const timeoutMs = Math.min(DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs, Math.max(1_000, Number(args.timeoutMs ?? DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs)));
        const execution = await this.provider.exec(this.workspace, {
          command, timeoutMs, maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, signal: this.options.signal,
        });
        const stdout = validateSandboxOutput(execution.stdout, DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, this.provider.name);
        const stderr = validateSandboxOutput(execution.stderr, DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, this.provider.name);
        return result(JSON.stringify({ exitCode: execution.exitCode, stdout, stderr, durationMs: execution.durationMs }), true);
      }
      if (call.tool === "repository_read_file") {
        const bytes = await this.provider.readFile(this.workspace, String(args.path ?? ""), DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return result(validateSandboxOutput(text, DEFAULT_WORKSPACE_LIMITS.maxFileBytes, this.provider.name), true);
      }
      if (call.tool === "repository_write_file") {
        const content = String(args.content ?? "");
        const bytes = new TextEncoder().encode(content);
        await this.provider.writeFile(this.workspace, String(args.path ?? ""), bytes, DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
        return result(JSON.stringify({ written: bytes.byteLength }), true);
      }
      const files = await this.provider.listFiles(this.workspace, String(args.path ?? "."), 2_000);
      return result(JSON.stringify(files), true);
    } catch (error) {
      const message = error instanceof CloudWorkspaceError ? `${error.code}: ${error.message}` : "invalid cloud repository tool request";
      return result(message, false);
    }
  }
}
