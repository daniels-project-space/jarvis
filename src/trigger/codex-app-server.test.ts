import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer,
  CodexPermissionAttestationError,
  type CodexDynamicToolResult,
  type CodexDynamicToolSpec,
  type CodexPermissionProfileOptions,
  type CodexTurnInput,
} from "./codex-app-server";

type AppServerInternals = {
  process: { stdin: { writable: boolean; write: (chunk: string) => boolean } };
  ready: Promise<void>;
  receive: (line: string) => void;
  protocolFailed: boolean;
};

type WrittenMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

function asOutputSchema(value: unknown): NonNullable<CodexTurnInput["outputSchema"]> {
  return value as NonNullable<CodexTurnInput["outputSchema"]>;
}

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
      modelTier: "luna",
      invocationContext: {
        requestId: "request-1",
        userMessageId: "message-1",
      },
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
      invocationContext: {
        requestId: "request-1",
        userMessageId: "message-1",
      },
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

  it("rejects unbounded tool invocation metadata before starting a Codex thread", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = {
      stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } },
    };
    internals.ready = Promise.resolve();

    await expect(server.runTurn({
      conversationId: "conversation-1",
      userText: "show me the dashboard",
      history: [],
      contextBlock: "",
      preamble: "test",
      modelTier: "luna",
      invocationContext: { requestId: "x".repeat(121) },
      onDelta: () => {},
    })).rejects.toThrow("requestId is invalid");
    expect(writes).toEqual([]);
  });

  it("preserves the foreground thread/start defaults when no permission profile is supplied", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();

    const turn = server.runTurn({
      conversationId: "foreground", userText: "hello", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].params).toEqual({
      model: "gpt-5.6-luna",
      baseInstructions: "test",
      developerInstructions: "Remain the foreground Jarvis conversation. Give the useful answer immediately. Delegate long work instead of blocking conversation.",
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
    });
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "foreground-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "foreground-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "foreground-turn", turn: { id: "foreground-turn", status: "completed" } } }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it("limits foreground execution to dynamic tools and consumes auth before model tools can run", async () => {
    const onAuthConsumed = vi.fn();
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      dynamicToolsOnly: true,
      onAuthConsumed,
    });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "foreground", userText: "hello", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].params).toMatchObject({
      environments: [],
      config: {
        web_search: "disabled",
        shell_environment_policy: { inherit: "none" },
        features: { shell_tool: false, unified_exec: false, apps: false, plugins: false, multi_agent: false },
      },
    });
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "foreground-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(onAuthConsumed).not.toHaveBeenCalled();
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "foreground-turn" } } }));
    await vi.waitFor(() => expect(onAuthConsumed).toHaveBeenCalledTimes(1));
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "foreground-turn", turn: { id: "foreground-turn", status: "completed" } } }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it("sends named permissions without legacy sandbox and starts a turn only after exact attestation", async () => {
    const permissionProfile: CodexPermissionProfileOptions = {
      id: "jarvis_cloud_bridge",
      config: { permissions: { jarvis_cloud_bridge: { network: { enabled: false } } } },
      environments: [],
      runtimeWorkspaceRoots: ["/tmp/controller-safe"],
      expected: { activePermissionProfileId: "jarvis_cloud_bridge", sandbox: { type: "readOnly", networkAccess: false } },
    };
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, { permissionProfile });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "cloud", userText: "work", history: [], contextBlock: "",
      preamble: "test", modelTier: "terra", onDelta: () => {},
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].params).toMatchObject({
      permissions: "jarvis_cloud_bridge", config: permissionProfile.config,
      environments: [], runtimeWorkspaceRoots: ["/tmp/controller-safe"],
    });
    expect(writes[0].params).not.toHaveProperty("sandbox");
    internals.receive(JSON.stringify({ id: writes[0].id, result: {
      thread: { id: "cloud-thread" }, activePermissionProfile: { id: "jarvis_cloud_bridge" },
      sandbox: { type: "readOnly", networkAccess: false },
    } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].method).toBe("turn/start");
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "cloud-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "cloud-turn", turn: { id: "cloud-turn", status: "completed" } } }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it.each([
    ["missing profile", { thread: { id: "cloud-thread" }, sandbox: { type: "readOnly", networkAccess: false } }],
    ["wrong profile", { thread: { id: "cloud-thread" }, activePermissionProfile: { id: "other" }, sandbox: { type: "readOnly", networkAccess: false } }],
    ["network enabled", { thread: { id: "cloud-thread" }, activePermissionProfile: { id: "jarvis_cloud_bridge" }, sandbox: { type: "readOnly", networkAccess: true } }],
    ["wrong sandbox", { thread: { id: "cloud-thread" }, activePermissionProfile: { id: "jarvis_cloud_bridge" }, sandbox: { type: "workspaceWrite", networkAccess: false } }],
  ])("blocks before turn/start when permission attestation is %s", async (_label, response) => {
    const permissionProfile: CodexPermissionProfileOptions = {
      id: "jarvis_cloud_bridge", config: {}, environments: [], runtimeWorkspaceRoots: ["/tmp/controller-safe"],
      expected: { activePermissionProfileId: "jarvis_cloud_bridge", sandbox: { type: "readOnly", networkAccess: false } },
    };
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, { permissionProfile });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "blocked", userText: "must not run", history: [], contextBlock: "",
      preamble: "test", modelTier: "terra", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: response }));
    await expect(turn).rejects.toMatchObject({
      name: "CodexPermissionAttestationError", code: "permission_attestation_failed", disposition: "blocked",
    } satisfies Partial<CodexPermissionAttestationError>);
    expect(writes).toHaveLength(1);
    expect(writes.some((message) => message.method === "turn/start")).toBe(false);
  });

  it("types an unavailable thread/start attestation as blocked and emits no turn", async () => {
    const permissionProfile: CodexPermissionProfileOptions = {
      id: "jarvis_cloud_bridge", config: {}, environments: [], runtimeWorkspaceRoots: ["/tmp/controller-safe"],
      expected: { activePermissionProfileId: "jarvis_cloud_bridge", sandbox: { type: "readOnly", networkAccess: false } },
    };
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, { permissionProfile });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "unavailable", userText: "must not run", history: [], contextBlock: "",
      preamble: "test", modelTier: "terra", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, error: { message: "profile unavailable" } }));
    await expect(turn).rejects.toMatchObject({ code: "permission_attestation_failed", disposition: "blocked" });
    expect(writes).toHaveLength(1);
  });

  it("fails closed when cumulative assistant output exceeds the per-turn bound", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      protocolLimits: { assistantBytesPerTurn: 4 },
    });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "bounded", userText: "hello", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "bounded-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "bounded-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { turnId: "bounded-turn", delta: "12345" },
    }));
    await expect(turn).rejects.toThrow("protocol validation failed");
    expect(internals.protocolFailed).toBe(true);
  });

  it("bounds pending requests before allocating another protocol id", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      protocolLimits: { pendingRequests: 1 },
    });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const first = server.runTurn({
      conversationId: "first", userText: "one", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    await expect(server.runTurn({
      conversationId: "second", userText: "two", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    })).rejects.toThrow("pending request limit");
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "first-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "first-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "first-turn", turn: { id: "first-turn", status: "completed" } } }));
    await expect(first).resolves.toMatchObject({ code: 0 });
  });

  it("bounds cumulative dynamic-tool output and terminates the accepted turn", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      protocolLimits: { toolOutputBytes: 8 },
      onDynamicToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "bounded result" }],
        success: true,
      }),
    });
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "tool-bound", userText: "work", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "tool-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "tool-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({
      id: 99,
      method: "item/tool/call",
      params: {
        threadId: "tool-thread", turnId: "tool-turn", callId: "call-99",
        namespace: null, tool: "jarvis_call_tool", arguments: {},
      },
    }));
    await expect(turn).rejects.toThrow("protocol validation failed");
    expect(internals.protocolFailed).toBe(true);
  });

  it("caps cumulative protocol bytes even when every individual JSON line is small", () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, {
      protocolLimits: { stdoutBytes: 90 },
    });
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: () => true } };
    internals.ready = Promise.resolve();
    const notification = JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt" } });
    internals.receive(notification);
    expect(internals.protocolFailed).toBe(false);
    internals.receive(notification);
    expect(internals.protocolFailed).toBe(true);
  });

  it("passes a validated output schema verbatim only to turn/start", async () => {
    const outputSchema = {
      type: "object",
      properties: {
        answer: { type: "string" },
      },
      required: ["answer"],
    } satisfies NonNullable<CodexTurnInput["outputSchema"]>;
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "structured", userText: "hello", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", outputSchema, onDelta: () => {},
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].params).not.toHaveProperty("outputSchema");
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "structured-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].method).toBe("turn/start");
    expect(writes[1].params?.outputSchema).toEqual(outputSchema);
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "structured-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { turnId: "structured-turn", turn: { id: "structured-turn", status: "completed" } },
    }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it("omits outputSchema from turn/start when it is absent", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const turn = server.runTurn({
      conversationId: "unstructured", userText: "hello", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", onDelta: () => {},
    });

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "unstructured-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].params).not.toHaveProperty("outputSchema");
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "unstructured-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { turnId: "unstructured-turn", turn: { id: "unstructured-turn", status: "completed" } },
    }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it.each([
    ["malformed", () => ({ type: undefined })],
    ["cyclic", () => {
      const schema: Record<string, unknown> = {};
      schema.self = schema;
      return schema;
    }],
    ["oversized", () => ({ description: "x".repeat(32 * 1_024) })],
    ["too deep", () => {
      const schema: Record<string, unknown> = {};
      let current = schema;
      for (let index = 0; index < 16; index += 1) {
        const next: Record<string, unknown> = {};
        current.next = next;
        current = next;
      }
      return schema;
    }],
    ["root null", () => null],
    ["root primitive", () => "schema"],
    ["root array", () => []],
    ["forbidden __proto__ key", () => {
      const schema: Record<string, unknown> = {};
      Object.defineProperty(schema, "__proto__", { value: {}, enumerable: true });
      return schema;
    }],
    ["forbidden prototype key", () => ({ prototype: {} })],
    ["forbidden constructor key", () => ({ constructor: {} })],
    ["non-finite number", () => ({ maximum: Number.NaN })],
    ["symbol", () => {
      const schema: Record<string, unknown> = {};
      Object.defineProperty(schema, Symbol("forbidden"), { value: "value", enumerable: true });
      return schema;
    }],
    ["accessor", () => {
      const schema: Record<string, unknown> = {};
      Object.defineProperty(schema, "type", { enumerable: true, get: () => "object" });
      return schema;
    }],
    ["non-plain Date", () => new Date()],
    ["Proxy", () => new Proxy({}, {})],
    ["sparse array", () => ({ required: Array(1) })],
    ["custom-prototype array", () => {
      const values: unknown[] = [];
      Object.setPrototypeOf(values, {});
      return { required: values };
    }],
  ])("rejects a %s output schema before beforeTurn or protocol writes", async (_label, factory) => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const writes: WrittenMessage[] = [];
    const beforeTurn = vi.fn(async () => {});
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();

    await expect(server.runTurn({
      conversationId: "invalid-schema", userText: "hello", history: [], contextBlock: "",
      preamble: "test", modelTier: "luna", outputSchema: asOutputSchema(factory()),
      beforeTurn, onDelta: () => {},
    })).rejects.toThrow("Codex output schema is invalid");
    expect(beforeTurn).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});
