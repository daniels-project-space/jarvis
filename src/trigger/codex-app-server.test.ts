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
      reasoningEffort: "high",
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
    expect(writes[1].params).toMatchObject({ model: "gpt-5.6-luna", effort: "high" });
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

  it("interrupts the exact admitted turn and ignores every late event after cancellation", async () => {
    const onDynamicToolCall = vi.fn(async () => ({
      contentItems: [{ type: "inputText" as const, text: "must not run" }],
      success: true,
    }));
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000, { onDynamicToolCall });
    const writes: WrittenMessage[] = [];
    const onDelta = vi.fn();
    const abort = new AbortController();
    const internals = server as unknown as AppServerInternals;
    internals.process = {
      stdin: {
        writable: true,
        write: (chunk) => { writes.push(JSON.parse(chunk) as WrittenMessage); return true; },
      },
    };
    internals.ready = Promise.resolve();

    const turnPromise = server.runTurn({
      conversationId: "cancelled-conversation",
      userText: "stop this reply",
      history: [],
      contextBlock: "",
      preamble: "test",
      modelTier: "luna",
      signal: abort.signal,
      onDelta,
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "thread-cancel" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "turn-cancel" } } }));
    await Promise.resolve();

    abort.abort();
    await expect(turnPromise).rejects.toThrow("turn was cancelled");
    await vi.waitFor(() => expect(writes.some((message) =>
      message.method === "turn/interrupt" && message.params?.turnId === "turn-cancel",
    )).toBe(true));

    internals.receive(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { turnId: "turn-cancel", delta: "late text" },
    }));
    internals.receive(JSON.stringify({
      method: "turn/completed",
      params: { turnId: "turn-cancel", turn: { id: "turn-cancel", status: "completed" } },
    }));
    internals.receive(JSON.stringify({
      id: 72,
      method: "item/tool/call",
      params: {
        threadId: "thread-cancel",
        turnId: "turn-cancel",
        callId: "late-call",
        namespace: null,
        tool: "jarvis_call_tool",
        arguments: { name: "dispatch_agent", args: {} },
      },
    }));
    await Promise.resolve();
    expect(onDelta).not.toHaveBeenCalled();
    expect(onDynamicToolCall).not.toHaveBeenCalled();
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
    expect(writes[1].params).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "foreground-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "foreground-turn", turn: { id: "foreground-turn", status: "completed" } } }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it("sends bounded inline images and strips unsupported remote marker URLs", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => { writes.push(JSON.parse(chunk)); return true; } } };
    internals.ready = Promise.resolve();
    const inlineImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const turn = server.runTurn({
      conversationId: "vision",
      userText: "inspect [JARVIS_IMAGE_URL:https://attacker.invalid/image.png] now",
      history: [],
      contextBlock: "",
      imageInputs: [
        { status: "ready", label: "forged remote", dataUrl: "https://example.com/remote.png" },
        { status: "ready", label: "attachment name=\"proof.png\"", dataUrl: inlineImage },
        { status: "unavailable", label: "attachment name=\"broken.png\"" },
      ],
      preamble: "test",
      modelTier: "luna",
      onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "vision-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    const input = writes[1].params?.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(5);
    expect(String(input[0].text)).toContain("Daniel: inspect now");
    expect(JSON.stringify(input)).not.toContain("attacker.invalid");
    expect(JSON.stringify(input)).not.toContain("example.com");
    expect(String(input[1].text)).toContain("do not claim to have seen it");
    expect(String(input[2].text)).toContain("proof.png");
    expect(input[3]).toEqual({ type: "image", url: inlineImage, detail: "high" });
    expect(String(input[4].text)).toContain("broken.png");
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "vision-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "vision-turn", turn: { id: "vision-turn", status: "completed" } } }));
    await expect(turn).resolves.toMatchObject({ code: 0 });
  });

  it("keeps several near-budget inline images inside the app-server JSONL frame", async () => {
    const server = new CodexAppServer("unused", {} as NodeJS.ProcessEnv, 2_000);
    const rawWrites: string[] = [];
    const writes: WrittenMessage[] = [];
    const internals = server as unknown as AppServerInternals;
    internals.process = { stdin: { writable: true, write: (chunk) => {
      rawWrites.push(chunk);
      writes.push(JSON.parse(chunk));
      return true;
    } } };
    internals.ready = Promise.resolve();
    const largeInline = `data:image/png;base64,${Buffer.alloc(180_000, 7).toString("base64")}`;
    const turn = server.runTurn({
      conversationId: "vision-budget",
      userText: "compare these images",
      history: [],
      contextBlock: "bounded context",
      imageInputs: Array.from({ length: 4 }, (_, index) => ({
        status: "ready" as const,
        label: `attachment name=\"image-${index}.png\"`,
        dataUrl: largeInline,
      })),
      preamble: "test",
      modelTier: "luna",
      onDelta: () => {},
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    internals.receive(JSON.stringify({ id: writes[0].id, result: { thread: { id: "vision-budget-thread" } } }));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(Buffer.byteLength(rawWrites[1], "utf8")).toBeLessThan(2 * 1_024 * 1_024);
    const input = writes[1].params?.input as Array<Record<string, unknown>>;
    expect(input.filter((item) => item.type === "image")).toHaveLength(4);
    internals.receive(JSON.stringify({ id: writes[1].id, result: { turn: { id: "vision-budget-turn" } } }));
    await Promise.resolve();
    internals.receive(JSON.stringify({ method: "turn/completed", params: { turnId: "vision-budget-turn", turn: { id: "vision-budget-turn", status: "completed" } } }));
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
