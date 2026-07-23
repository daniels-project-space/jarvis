import { describe, expect, it } from "vitest";
import { BoundedAgentRunnerDecoder } from "./agent-runner-protocol";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("bounded agent runner JSONL", () => {
  it("accepts fragmented valid events and reports exact cumulative metrics", () => {
    const decoder = new BoundedAgentRunnerDecoder();
    const encoded = line({ type: "result", result: "done" });
    expect(decoder.push(encoded.slice(0, 5))).toEqual([]);
    expect(decoder.push(encoded.slice(5))).toEqual([{ type: "result", result: "done" }]);
    decoder.finish();
    expect(decoder.metrics()).toEqual({ messages: 1, assistantBytes: 4, toolEvents: 0, toolOutputBytes: 0 });
  });

  it.each([
    ["duplicate key", '{"type":"result","type":"error"}\n'],
    ["malformed", '{"type":"result" nope}\n'],
    ["non-object", '[]\n'],
    ["missing type", '{"result":"done"}\n'],
  ])("rejects %s JSONL", (_label, encoded) => {
    const decoder = new BoundedAgentRunnerDecoder();
    expect(() => decoder.push(encoded)).toThrowError(expect.objectContaining({ disposition: "failed_closed" }));
  });

  it("rejects oversized and truncated messages before they can accumulate", () => {
    const oversized = new BoundedAgentRunnerDecoder({ maximumLineBytes: 16 });
    expect(() => oversized.push('{"type":"result","result":"too long"}'))
      .toThrowError(expect.objectContaining({ reason: "invalid_jsonl" }));

    const truncated = new BoundedAgentRunnerDecoder();
    truncated.push('{"type":"result"');
    expect(() => truncated.finish()).toThrowError(expect.objectContaining({ reason: "invalid_jsonl" }));
  });

  it("enforces the message boundary at exact limit plus one", () => {
    const decoder = new BoundedAgentRunnerDecoder({ messages: 2 });
    expect(decoder.push(line({ type: "thread.started" }) + line({ type: "turn.started" }))).toHaveLength(2);
    expect(() => decoder.push(line({ type: "turn.completed" })))
      .toThrowError(expect.objectContaining({ reason: "message_limit" }));
  });

  it("enforces cumulative assistant bytes rather than only per-message size", () => {
    const decoder = new BoundedAgentRunnerDecoder({ assistantBytes: 5 });
    decoder.push(line({ type: "item.completed", item: { type: "agent_message", text: "123" } }));
    decoder.push(line({ type: "result", result: "45" }));
    expect(decoder.metrics().assistantBytes).toBe(5);
    expect(() => decoder.push(line({ type: "assistant", message: { content: [{ type: "text", text: "6" }] } })))
      .toThrowError(expect.objectContaining({ reason: "assistant_limit" }));
  });

  it("enforces cumulative tool event and output budgets", () => {
    const events = new BoundedAgentRunnerDecoder({ toolEvents: 2, toolOutputBytes: 4 });
    events.push(line({ type: "item.started", item: { type: "command_execution", command: "test" } }));
    events.push(line({ type: "item.completed", item: { type: "command_execution", aggregated_output: "1234" } }));
    expect(events.metrics()).toMatchObject({ toolEvents: 2, toolOutputBytes: 4 });
    expect(() => events.push(line({ type: "assistant", message: { content: [{ type: "tool_use", name: "shell" }] } })))
      .toThrowError(expect.objectContaining({ reason: "tool_event_limit" }));

    const output = new BoundedAgentRunnerDecoder({ toolEvents: 4, toolOutputBytes: 3 });
    expect(() => output.push(line({
      type: "item.completed",
      item: { type: "command_execution", output: "1234" },
    }))).toThrowError(expect.objectContaining({ reason: "tool_output_limit" }));
  });
});
