import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer,
  type CodexDynamicToolResult,
  type CodexDynamicToolSpec,
} from "./codex-app-server";

type AppServerInternals = {
  process: { stdin: { writable: boolean; write: (chunk: string) => boolean } };
  ready: Promise<void>;
  receive: (line: string) => void;
};

type WrittenMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

describe("Codex app-server dynamic tools", () => {
  it("registers a native tool and answers server-initiated calls over JSONL", async () => {
    const dynamicTools: CodexDynamicToolSpec[] = [{
      type: "function",
      name: "jarvis_call_tool",
      description: "Call Jarvis.",
      inputSchema: { type: "object" },
    }];
    const toolResult: CodexDynamicToolResult = {
      contentItems: [{ type: "inputText", text: "bridge result" }],
      success: true,
    };
    const onDynamicToolCall = vi.fn(async () => toolResult);
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      dynamicTools,
      onDynamicToolCall,
    });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = {
      stdin: {
        writable: true,
        write: (chunk) => {
          writes.push(JSON.parse(chunk) as WrittenMessage);
          return true;
        },
      },
    };
    internals.ready = Promise.resolve();

    const turnPromise = server.runTurn({
      conversationId: "conversation-1",
      userText: "show me the dashboard",
      history: [],
      contextBlock: "",
      preamble: "test",
      modelTier: "haiku",
      onDelta: () => {},
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe("thread/start");
    expect(writes[0].params?.dynamicTools).toEqual(dynamicTools);
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "thread-1" } } }));

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].method).toBe("turn/start");
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "turn-1" } } }));
    await Promise.resolve();

    internals.receive(JSON.stringify({
      id: 71,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "jarvis_call_tool",
        arguments: { name: "show", args: { panel: "dashboard" } },
      },
    }));

    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(onDynamicToolCall).toHaveBeenCalledWith({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "jarvis_call_tool",
      arguments: { name: "show", args: { panel: "dashboard" } },
    });
    expect(writes[2]).toEqual({ id: 71, result: toolResult });

    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { turnId: "turn-1", delta: "done" },
    }));
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { turnId: "turn-1", turn: { id: "turn-1", status: "completed" } },
    }));
    await expect(turnPromise).resolves.toMatchObject({ finalText: "done", threadId: "thread-1", code: 0 });
  });
});
