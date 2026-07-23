import { BoundedJsonLineDecoder } from "../lib/bounded-json-lines";
import { isJsonRecord } from "../lib/bounded-json";

export type AgentRunnerProtocolLimits = Readonly<{
  maximumLineBytes: number;
  messages: number;
  assistantBytes: number;
  toolEvents: number;
  toolOutputBytes: number;
}>;

export const AGENT_RUNNER_PROTOCOL_LIMITS: AgentRunnerProtocolLimits = Object.freeze({
  maximumLineBytes: 2 * 1_024 * 1_024,
  messages: 200_000,
  assistantBytes: 4 * 1_024 * 1_024,
  toolEvents: 4_096,
  toolOutputBytes: 16 * 1_024 * 1_024,
});

export type AgentRunnerProtocolFailureReason =
  | "invalid_limits"
  | "invalid_jsonl"
  | "invalid_event"
  | "message_limit"
  | "assistant_limit"
  | "tool_event_limit"
  | "tool_output_limit";

export class AgentRunnerProtocolError extends Error {
  readonly code = "jarvis_agent_runner_protocol_failed";
  readonly disposition = "failed_closed";

  constructor(readonly reason: AgentRunnerProtocolFailureReason) {
    super(`agent runner protocol failed closed (${reason})`);
    this.name = "AgentRunnerProtocolError";
  }
}

export type AgentRunnerEvent = Record<string, unknown>;

function boundedLimits(overrides: Partial<AgentRunnerProtocolLimits>): AgentRunnerProtocolLimits {
  const result = { ...AGENT_RUNNER_PROTOCOL_LIMITS, ...overrides };
  if (Object.values(result).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new AgentRunnerProtocolError("invalid_limits");
  }
  return Object.freeze(result);
}

function byteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function itemRecord(event: AgentRunnerEvent): Record<string, unknown> | null {
  return isJsonRecord(event.item) ? event.item : null;
}

function selectedToolOutput(item: Record<string, unknown>): unknown {
  return item.aggregated_output ?? item.output ?? item.stdout ?? item.stderr;
}

/** Strict JSONL plus cumulative semantic budgets for Codex exec output. */
export class BoundedAgentRunnerDecoder {
  private readonly limits: AgentRunnerProtocolLimits;
  private readonly decoder: BoundedJsonLineDecoder;
  private messageCount = 0;
  private assistantByteCount = 0;
  private toolEventCount = 0;
  private toolOutputByteCount = 0;

  constructor(overrides: Partial<AgentRunnerProtocolLimits> = {}) {
    this.limits = boundedLimits(overrides);
    this.decoder = new BoundedJsonLineDecoder(this.limits.maximumLineBytes);
  }

  push(chunk: Uint8Array | string): AgentRunnerEvent[] {
    let decoded: unknown[];
    try {
      decoded = this.decoder.push(chunk);
    } catch (error) {
      if (error instanceof AgentRunnerProtocolError) throw error;
      throw new AgentRunnerProtocolError("invalid_jsonl");
    }
    const events: AgentRunnerEvent[] = [];
    for (const value of decoded) {
      this.messageCount += 1;
      if (this.messageCount > this.limits.messages) {
        throw new AgentRunnerProtocolError("message_limit");
      }
      if (!isJsonRecord(value)
        || typeof value.type !== "string"
        || !value.type
        || value.type.length > 128) {
        throw new AgentRunnerProtocolError("invalid_event");
      }
      this.account(value);
      events.push(value);
    }
    return events;
  }

  finish(): void {
    try {
      this.decoder.finish();
    } catch {
      throw new AgentRunnerProtocolError("invalid_jsonl");
    }
  }

  metrics(): Readonly<{
    messages: number;
    assistantBytes: number;
    toolEvents: number;
    toolOutputBytes: number;
  }> {
    return Object.freeze({
      messages: this.messageCount,
      assistantBytes: this.assistantByteCount,
      toolEvents: this.toolEventCount,
      toolOutputBytes: this.toolOutputByteCount,
    });
  }

  private addAssistant(value: unknown): void {
    this.assistantByteCount += byteLength(value);
    if (!Number.isSafeInteger(this.assistantByteCount)
      || this.assistantByteCount > this.limits.assistantBytes) {
      throw new AgentRunnerProtocolError("assistant_limit");
    }
  }

  private addTool(output: unknown): void {
    this.toolEventCount += 1;
    if (this.toolEventCount > this.limits.toolEvents) {
      throw new AgentRunnerProtocolError("tool_event_limit");
    }
    this.toolOutputByteCount += byteLength(output);
    if (!Number.isSafeInteger(this.toolOutputByteCount)
      || this.toolOutputByteCount > this.limits.toolOutputBytes) {
      throw new AgentRunnerProtocolError("tool_output_limit");
    }
  }

  private account(event: AgentRunnerEvent): void {
    const item = itemRecord(event);
    if ((event.type === "item.started" || event.type === "item.completed") && item) {
      const itemType = typeof item.type === "string" ? item.type : "";
      if (event.type === "item.completed" && itemType === "agent_message") {
        this.addAssistant(item.text);
      }
      if (itemType === "command_execution" || itemType.includes("tool")) {
        this.addTool(event.type === "item.completed" ? selectedToolOutput(item) : undefined);
      }
    }

    if (event.type === "assistant" && isJsonRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isJsonRecord(block)) continue;
        if (block.type === "text") this.addAssistant(block.text);
        else if (block.type === "tool_use" || block.type === "tool_result") {
          this.addTool(block.type === "tool_result" ? block.content : undefined);
        }
      }
    }
    if (event.type === "result") this.addAssistant(event.result);
  }
}
