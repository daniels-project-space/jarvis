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

function attach(server: CodexAppServer) {
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
  return { internals, writes };
}

function respond(
  internals: AppServerInternals,
  message: WrittenMessage,
  result: Record<string, unknown>,
) {
  internals.receive(JSON.stringify({ id: message.id, result }));
}

describe("Codex app-server protocol", () => {
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
      modelTier: "luna",
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

  it("replays deltas and completion that arrive before the turn/start response", async () => {
    let now = 0;
    const deltas: string[] = [];
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      now: () => now,
    });
    const { internals, writes } = attach(server);
    const turnPromise = server.runTurn({
      conversationId: "conversation-early",
      turnKey: "message-early",
      userText: "Reply with exactly EARLY_OK",
      history: [],
      contextBlock: "Ground truth only.",
      turnDirective: "Do not add prose.",
      preamble: "stable instructions",
      modelTier: "luna",
      onDelta: (delta) => deltas.push(delta),
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    now = 5;
    respond(internals, writes[0], { thread: { id: "thread-early" } });
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-early",
        clientUserMessageId: "message-early",
        input: [{ type: "text", text: "Reply with exactly EARLY_OK" }],
        additionalContext: {
          "jarvis-live-context": { value: "Ground truth only.", kind: "application" },
          "jarvis-turn-guidance": { value: "Do not add prose.", kind: "application" },
        },
      },
    });

    now = 8;
    internals.receive(JSON.stringify({
      method: "turn/started",
      params: { threadId: "thread-early", turn: { id: "turn-early", status: "inProgress" } },
    }));
    now = 11;
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-early", turnId: "turn-early", itemId: "item-early", delta: "EARLY_OK" },
    }));
    now = 13;
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-early", turn: { id: "turn-early", status: "completed" } },
    }));
    now = 20;
    respond(internals, writes[1], { turn: { id: "turn-early" } });

    await expect(turnPromise).resolves.toMatchObject({
      finalText: "EARLY_OK",
      timing: {
        turnResponseMs: 15,
        firstDeltaMs: 6,
        generationMs: 2,
        bufferedEventCount: 3,
        firstDeltaBeforeTurnResponse: true,
      },
    });
    expect(deltas).toEqual(["EARLY_OK"]);

    // Late duplicates cannot complete twice, append stale text, or duplicate
    // the handoff transcript after the active consumer has been removed.
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-early", turnId: "turn-early", itemId: "item-early", delta: "_STALE" },
    }));
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-early", turn: { id: "turn-early", status: "completed" } },
    }));
    expect(deltas).toEqual(["EARLY_OK"]);
    expect(server.handoffConversations()).toEqual([{
      conversationId: "conversation-early",
      modelTier: "luna",
      history: [
        { role: "user", text: "Reply with exactly EARLY_OK" },
        { role: "assistant", text: "EARLY_OK" },
      ],
    }]);
  });

  it("keeps interleaved early notifications isolated by turn and thread", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const { internals, writes } = attach(server);
    const a: string[] = [];
    const b: string[] = [];
    const first = server.runTurn({
      conversationId: "conversation-a",
      userText: "A",
      history: [],
      contextBlock: "",
      preamble: "test",
      modelTier: "luna",
      onDelta: (delta) => a.push(delta),
    });
    const second = server.runTurn({
      conversationId: "conversation-b",
      userText: "B",
      history: [],
      contextBlock: "",
      preamble: "test",
      modelTier: "luna",
      onDelta: (delta) => b.push(delta),
    });

    await vi.waitFor(() => expect(writes).toHaveLength(2));
    respond(internals, writes[0], { thread: { id: "thread-a" } });
    respond(internals, writes[1], { thread: { id: "thread-b" } });
    await vi.waitFor(() => expect(writes).toHaveLength(4));
    const turnA = writes.find((message) => message.method === "turn/start" && message.params?.threadId === "thread-a")!;
    const turnB = writes.find((message) => message.method === "turn/start" && message.params?.threadId === "thread-b")!;

    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", delta: "A1" },
    }));
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-b", turnId: "turn-b", itemId: "item-b", delta: "B1" },
    }));
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", delta: "A2" },
    }));
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-b", turn: { id: "turn-b", status: "completed" } },
    }));
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } },
    }));

    respond(internals, turnB, { turn: { id: "turn-b" } });
    await Promise.resolve();
    respond(internals, turnA, { turn: { id: "turn-a" } });
    await expect(first).resolves.toMatchObject({ finalText: "A1A2", threadId: "thread-a" });
    await expect(second).resolves.toMatchObject({ finalText: "B1", threadId: "thread-b" });
    expect(a).toEqual(["A1", "A2"]);
    expect(b).toEqual(["B1"]);
  });

  it("ignores a notification whose thread does not match the registered turn", async () => {
    const deltas: string[] = [];
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const { internals, writes } = attach(server);
    const result = server.runTurn({
      conversationId: "conversation-thread-guard",
      userText: "guard",
      history: [],
      contextBlock: "",
      preamble: "test",
      modelTier: "luna",
      onDelta: (delta) => deltas.push(delta),
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    respond(internals, writes[0], { thread: { id: "thread-right" } });
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    respond(internals, writes[1], { turn: { id: "turn-shared" } });
    await Promise.resolve();
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-wrong", turnId: "turn-shared", itemId: "wrong", delta: "WRONG" },
    }));
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-right", turnId: "turn-shared", itemId: "right", delta: "RIGHT" },
    }));
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-right", turn: { id: "turn-shared", status: "completed" } },
    }));
    await expect(result).resolves.toMatchObject({ finalText: "RIGHT" });
    expect(deltas).toEqual(["RIGHT"]);
  });

  it("prewarms a bounded history-seeded conversation and keeps dynamic tools", async () => {
    const dynamicTools: CodexDynamicToolSpec[] = [{
      type: "function",
      name: "jarvis_call_tool",
      description: "Call Jarvis.",
      inputSchema: { type: "object" },
    }];
    const firstServer = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, { dynamicTools });
    const firstHarness = attach(firstServer);
    const firstTurn = firstServer.runTurn({
      conversationId: "conversation-warm",
      userText: "current question",
      history: [
        { role: "user", text: "older question" },
        { role: "assistant", text: "older answer" },
      ],
      contextBlock: "",
      preamble: "stable instructions",
      modelTier: "terra",
      onDelta: () => {},
    });
    await vi.waitFor(() => expect(firstHarness.writes).toHaveLength(1));
    respond(firstHarness.internals, firstHarness.writes[0], { thread: { id: "thread-old" } });
    await vi.waitFor(() => expect(firstHarness.writes).toHaveLength(2));
    expect(firstHarness.writes[1].method).toBe("thread/inject_items");
    respond(firstHarness.internals, firstHarness.writes[1], {});
    await vi.waitFor(() => expect(firstHarness.writes).toHaveLength(3));
    respond(firstHarness.internals, firstHarness.writes[2], { turn: { id: "turn-old" } });
    await Promise.resolve();
    firstHarness.internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-old", turnId: "turn-old", itemId: "item-old", delta: "current answer" },
    }));
    firstHarness.internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-old", turn: { id: "turn-old", status: "completed" } },
    }));
    await firstTurn;

    const handoff = firstServer.handoffConversations(1);
    const successor = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, { dynamicTools });
    const nextHarness = attach(successor);
    const prewarm = successor.prewarmConversations(handoff, "stable instructions");
    await vi.waitFor(() => expect(nextHarness.writes).toHaveLength(1));
    expect(nextHarness.writes[0]).toMatchObject({
      method: "thread/start",
      params: { dynamicTools },
    });
    respond(nextHarness.internals, nextHarness.writes[0], { thread: { id: "thread-warm" } });
    await vi.waitFor(() => expect(nextHarness.writes).toHaveLength(2));
    expect(nextHarness.writes[1].method).toBe("thread/inject_items");
    expect(nextHarness.writes[1].params?.items).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "older question" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "older answer" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "current question" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "current answer" }] },
    ]);
    respond(nextHarness.internals, nextHarness.writes[1], {});
    await expect(prewarm).resolves.toBe(1);

    const warmTurn = successor.runTurn({
      conversationId: "conversation-warm",
      userText: "new exact probe",
      history: [{ role: "assistant", text: "must not be injected twice" }],
      contextBlock: "fresh context",
      preamble: "stable instructions",
      modelTier: "luna",
      onDelta: () => {},
    });
    await vi.waitFor(() => expect(nextHarness.writes).toHaveLength(3));
    expect(nextHarness.writes[2]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-warm",
        input: [{ type: "text", text: "new exact probe" }],
        additionalContext: {
          "jarvis-live-context": { value: "fresh context", kind: "application" },
        },
      },
    });
    respond(nextHarness.internals, nextHarness.writes[2], { turn: { id: "turn-warm" } });
    await Promise.resolve();
    nextHarness.internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-warm", turnId: "turn-warm", itemId: "item-warm", delta: "warm answer" },
    }));
    nextHarness.internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-warm", turn: { id: "turn-warm", status: "completed" } },
    }));
    await expect(warmTurn).resolves.toMatchObject({ finalText: "warm answer", threadId: "thread-warm" });
    expect(nextHarness.writes.filter((message) => message.method === "thread/start")).toHaveLength(1);
  });
});
