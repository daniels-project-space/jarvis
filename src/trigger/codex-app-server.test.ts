import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer,
  CodexPermissionAttestationError,
  type CodexDynamicToolResult,
  type CodexDynamicToolSpec,
  type CodexPermissionProfileOptions,
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
      preamble: "test", modelTier: "terra", reasoningEffort: "high", onDelta: () => {},
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
    expect(writes[1].params).toMatchObject({ model: "gpt-5.6-terra", effort: "high" });
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
});
