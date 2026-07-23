import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import {
  CodexRequestOutcomeUnknownError,
  type CodexAppServerOptions,
} from "../trigger/codex-app-server";
import {
  CHATGPT_LOGIN_STATUS_RECEIPT,
  PINNED_CODEX_VERSION,
} from "../trigger/subscription-runtime";
import { prepareCodexSubscriptionCall } from "./codex-subscription-codec";
import {
  createCodexSubscriptionLanguageModel,
  type CodexSubscriptionLanguageModelDependencies,
} from "./codex-subscription-model";

type Dependencies = CodexSubscriptionLanguageModelDependencies;
type AppServer = ReturnType<Dependencies["createAppServer"]>;
type TurnInput = Parameters<AppServer["runTurn"]>[0];

function call(
  overrides: Partial<LanguageModelV2CallOptions> = {},
): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  };
}

function uncheckedCall(value: unknown): LanguageModelV2CallOptions {
  return value as LanguageModelV2CallOptions;
}

function uncheckedTool(value: unknown): LanguageModelV2FunctionTool {
  return value as LanguageModelV2FunctionTool;
}

async function streamParts(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV2StreamPart[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return parts;
    parts.push(next.value);
  }
}

interface Harness {
  readonly env: NodeJS.ProcessEnv;
  readonly createdCwds: string[];
  readonly cwdObservations: Array<{
    path: string;
    mode: number;
    entries: string[];
  }>;
  readonly prepareSubscriptionEnv: ReturnType<typeof vi.fn<Dependencies["prepareSubscriptionEnv"]>>;
  readonly resolveSubscriptionAgentBin: ReturnType<typeof vi.fn<Dependencies["resolveSubscriptionAgentBin"]>>;
  readonly verifyCodexSubscriptionPreflight: ReturnType<typeof vi.fn<Dependencies["verifyCodexSubscriptionPreflight"]>>;
  readonly cleanupSubscriptionHome: ReturnType<typeof vi.fn<Dependencies["cleanupSubscriptionHome"]>>;
  readonly consumeSubscriptionAuth: ReturnType<typeof vi.fn<Dependencies["consumeSubscriptionAuth"]>>;
  readonly backgroundSubscriptionValidityMs: ReturnType<typeof vi.fn<Dependencies["backgroundSubscriptionValidityMs"]>>;
  readonly createControllerCwd: ReturnType<typeof vi.fn<Dependencies["createControllerCwd"]>>;
  readonly removeControllerCwd: ReturnType<typeof vi.fn<Dependencies["removeControllerCwd"]>>;
  readonly createAppServer: ReturnType<typeof vi.fn<Dependencies["createAppServer"]>>;
  readonly createId: ReturnType<typeof vi.fn<Dependencies["createId"]>>;
  readonly now: ReturnType<typeof vi.fn<Dependencies["now"]>>;
  readonly runTurn: ReturnType<typeof vi.fn<AppServer["runTurn"]>>;
  readonly stop: ReturnType<typeof vi.fn<AppServer["stop"]>>;
  readonly dependencies: Partial<Dependencies>;
}

function harness(): Harness {
  const env = {
    NODE_ENV: "test",
    PATH: "/usr/bin",
    CODEX_HOME: "/tmp/owned-codex-home",
  } as NodeJS.ProcessEnv;
  const createdCwds: string[] = [];
  const cwdObservations: Harness["cwdObservations"] = [];
  let id = 0;

  const prepareSubscriptionEnv = vi.fn<Dependencies["prepareSubscriptionEnv"]>(
    async () => ({
      env,
      snapshotVersion: 3,
      snapshotExpiresAt: Date.now() + 1_000_000,
      snapshotFence: 9,
    }),
  );
  const resolveSubscriptionAgentBin = vi.fn<Dependencies["resolveSubscriptionAgentBin"]>(
    () => "/pinned/codex",
  );
  const verifyCodexSubscriptionPreflight = vi.fn<Dependencies["verifyCodexSubscriptionPreflight"]>(
    () => ({
      receipt: {
        version: PINNED_CODEX_VERSION,
        loginStatus: CHATGPT_LOGIN_STATUS_RECEIPT,
      },
    }),
  );
  const cleanupSubscriptionHome = vi.fn<Dependencies["cleanupSubscriptionHome"]>(
    () => true,
  );
  const consumeSubscriptionAuth = vi.fn<Dependencies["consumeSubscriptionAuth"]>(
    () => undefined,
  );
  const backgroundSubscriptionValidityMs = vi.fn<
    Dependencies["backgroundSubscriptionValidityMs"]
  >(() => 777_000);
  const createControllerCwd = vi.fn<Dependencies["createControllerCwd"]>(() => {
    const cwd = mkdtempSync(join(tmpdir(), "jarvis-mastra-model-test-"));
    chmodSync(cwd, 0o700);
    createdCwds.push(cwd);
    return cwd;
  });
  const removeControllerCwd = vi.fn<Dependencies["removeControllerCwd"]>((cwd) => {
    rmSync(cwd, { recursive: true, force: true });
  });
  const runTurn = vi.fn<AppServer["runTurn"]>(async () => ({
    finalText: "{\"kind\":\"text\",\"text\":\"ready\"}",
    threadId: "codex-thread",
    code: 0,
    stderr: "",
  }));
  const stop = vi.fn<AppServer["stop"]>(() => undefined);
  const createAppServer = vi.fn<Dependencies["createAppServer"]>(
    (_bin, _environment, _timeout, options) => {
      const cwd = String(options.controllerCwd);
      cwdObservations.push({
        path: cwd,
        mode: statSync(cwd).mode & 0o777,
        entries: readdirSync(cwd),
      });
      return { runTurn, stop };
    },
  );
  const createId = vi.fn<Dependencies["createId"]>(() => {
    id += 1;
    return `host-${id}`;
  });
  const startedAt = new Date("2026-07-22T12:00:00.000Z");
  const now = vi.fn<Dependencies["now"]>(() => startedAt);

  return {
    env,
    createdCwds,
    cwdObservations,
    prepareSubscriptionEnv,
    resolveSubscriptionAgentBin,
    verifyCodexSubscriptionPreflight,
    cleanupSubscriptionHome,
    consumeSubscriptionAuth,
    backgroundSubscriptionValidityMs,
    createControllerCwd,
    removeControllerCwd,
    createAppServer,
    createId,
    now,
    runTurn,
    stop,
    dependencies: {
      prepareSubscriptionEnv,
      resolveSubscriptionAgentBin,
      verifyCodexSubscriptionPreflight,
      cleanupSubscriptionHome,
      consumeSubscriptionAuth,
      backgroundSubscriptionValidityMs,
      createControllerCwd,
      removeControllerCwd,
      createAppServer,
      createId,
      now,
    },
  };
}

function model(h: Harness, tier: "luna" | "terra" | "sol" = "terra") {
  return createCodexSubscriptionLanguageModel({
    modelTier: tier,
    turnTimeoutMs: 1_000,
  }, h.dependencies);
}

function cleanupHarness(h: Harness): void {
  for (const cwd of h.createdCwds) {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("createCodexSubscriptionLanguageModel", () => {
  it("exposes only the exact v2 subscription model surface and validates config", () => {
    const h = harness();
    const value = model(h);
    expect({
      specificationVersion: value.specificationVersion,
      provider: value.provider,
      modelId: value.modelId,
      supportedUrls: value.supportedUrls,
    }).toEqual({
      specificationVersion: "v2",
      provider: "codex-subscription",
      modelId: "gpt-5.6-terra",
      supportedUrls: {},
    });
    expect(Object.keys(value).sort()).toEqual([
      "doGenerate",
      "doStream",
      "modelId",
      "provider",
      "specificationVersion",
      "supportedUrls",
    ]);
    expect(() => createCodexSubscriptionLanguageModel(
      uncheckedCall({ modelTier: "unknown", turnTimeoutMs: 1_000 }) as unknown as {
        modelTier: "luna";
        turnTimeoutMs: number;
      },
      h.dependencies,
    )).toThrow(/model tier/);
    for (const turnTimeoutMs of [0, 300_001, 1.5]) {
      expect(() => createCodexSubscriptionLanguageModel({
        modelTier: "terra",
        turnTimeoutMs,
      }, h.dependencies)).toThrow(/turn timeout/);
    }
    cleanupHarness(h);
  });

  it("validates the codec, transport schema, and pre-abort before acquisition", async () => {
    const h = harness();
    const value = model(h);
    await expect(value.doGenerate(uncheckedCall({
      prompt: new Proxy([], {}),
    }))).rejects.toThrow(/ordinary dense array/);

    let nested: unknown = { type: "string" };
    for (let index = 0; index < 18; index += 1) {
      nested = { type: "array", items: nested };
    }
    await expect(value.doGenerate(call({
      tools: [uncheckedTool({
        type: "function",
        name: "deep",
        inputSchema: nested,
      })],
    }))).rejects.toThrow(/output schema is invalid/);

    const controller = new AbortController();
    controller.abort();
    await expect(value.doGenerate(call({
      abortSignal: controller.signal,
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(h.prepareSubscriptionEnv).not.toHaveBeenCalled();
    expect(h.createAppServer).not.toHaveBeenCalled();
    cleanupHarness(h);
  });

  it("runs one exact read-only subscription turn and returns host metadata", async () => {
    const h = harness();
    const options = call({ topK: 3 });
    const expected = prepareCodexSubscriptionCall(options);
    const result = await model(h).doGenerate(options);

    expect(h.backgroundSubscriptionValidityMs).toHaveBeenCalledOnce();
    expect(h.backgroundSubscriptionValidityMs).toHaveBeenCalledWith(1_000);
    expect(h.prepareSubscriptionEnv).toHaveBeenCalledOnce();
    const acquisition = h.prepareSubscriptionEnv.mock.calls[0];
    expect(acquisition?.[0]).toBe("codex");
    expect(acquisition?.[1]).toEqual({
      scope: "mastra-1-host-1",
      minimumValidityMs: 777_000,
    });
    expect(String(acquisition?.[1]?.scope).length).toBeLessThanOrEqual(64);
    expect(h.resolveSubscriptionAgentBin).toHaveBeenCalledWith("codex");
    expect(h.verifyCodexSubscriptionPreflight).toHaveBeenCalledWith(
      "/pinned/codex",
      h.env,
    );
    expect(h.cwdObservations).toEqual([{
      path: expect.stringMatching(/^\/tmp\/jarvis-mastra-model-test-/),
      mode: 0o700,
      entries: [],
    }]);
    expect(h.createAppServer).toHaveBeenCalledOnce();
    const appArgs = h.createAppServer.mock.calls[0];
    expect(appArgs?.slice(0, 3)).toEqual(["/pinned/codex", h.env, 1_000]);
    expect(appArgs?.[3]).toMatchObject({
      controllerCwd: h.cwdObservations[0]?.path,
      threadSandbox: "read-only",
      dynamicToolsOnly: true,
      dynamicTools: [],
      ephemeral: true,
    });
    expect(appArgs?.[3]?.developerInstructions).toMatch(/Mastra supervisor/);
    expect(appArgs?.[3]?.onDynamicToolCall).toBeUndefined();

    expect(h.runTurn).toHaveBeenCalledOnce();
    expect(h.runTurn).toHaveBeenCalledWith({
      conversationId: "host-2",
      userText: expected.promptText,
      history: [],
      contextBlock: "",
      preamble: "",
      modelTier: "terra",
      allowTools: false,
      outputSchema: expected.outputSchema,
      onDelta: expect.any(Function),
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "ready" }],
      finishReason: "stop",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      warnings: [{
        type: "unsupported-setting",
        setting: "topK",
        details: "Codex subscription runtime does not support this setting.",
      }],
      response: {
        id: "host-3",
        timestamp: new Date("2026-07-22T12:00:00.000Z"),
        modelId: "gpt-5.6-terra",
      },
    });
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.removeControllerCwd).toHaveBeenCalledOnce();
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledOnce();
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledWith(h.env);
    cleanupHarness(h);
  });

  it("uses the production helper to create an empty 0700 controller directory", async () => {
    const h = harness();
    const dependencies = { ...h.dependencies };
    delete dependencies.createControllerCwd;
    await createCodexSubscriptionLanguageModel({
      modelTier: "terra",
      turnTimeoutMs: 1_000,
    }, dependencies).doGenerate(call());
    expect(h.cwdObservations).toHaveLength(1);
    expect(h.cwdObservations[0]).toMatchObject({
      path: expect.stringMatching(/^\/tmp\/mastra-codex-controller-/),
      mode: 0o700,
      entries: [],
    });
    cleanupHarness(h);
  });

  it("acquires a fresh environment, scope, server, and turn for every call", async () => {
    const h = harness();
    const value = model(h, "luna");
    await value.doGenerate(call());
    await value.doGenerate(call());
    expect(h.prepareSubscriptionEnv).toHaveBeenCalledTimes(2);
    const scopes = h.prepareSubscriptionEnv.mock.calls.map((entry) => entry[1]?.scope);
    expect(scopes).toEqual(["mastra-1-host-1", "mastra-2-host-4"]);
    expect(new Set(scopes).size).toBe(2);
    expect(h.createAppServer).toHaveBeenCalledTimes(2);
    expect(h.runTurn).toHaveBeenCalledTimes(2);
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledTimes(2);
    cleanupHarness(h);
  });

  it("streams one decoded snapshot without a second server or fabricated usage", async () => {
    const h = harness();
    const response = await model(h, "sol").doStream(call());
    const parts = await streamParts(response.stream);
    expect(h.createAppServer).toHaveBeenCalledOnce();
    expect(h.runTurn).toHaveBeenCalledOnce();
    expect(parts).toEqual([
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: "host-3",
        modelId: "gpt-5.6-sol",
        timestamp: new Date("2026-07-22T12:00:00.000Z"),
      },
      { type: "text-start", id: "host-3.text" },
      { type: "text-delta", id: "host-3.text", delta: "ready" },
      { type: "text-end", id: "host-3.text" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);
    cleanupHarness(h);
  });

  it("wires auth consumption only to the existing helper and isolated env", async () => {
    const h = harness();
    await model(h).doGenerate(call());
    const options = h.createAppServer.mock.calls[0]?.[3] as
      | CodexAppServerOptions
      | undefined;
    expect(options?.onAuthConsumed).toEqual(expect.any(Function));
    options?.onAuthConsumed?.();
    expect(h.consumeSubscriptionAuth).toHaveBeenCalledOnce();
    expect(h.consumeSubscriptionAuth).toHaveBeenCalledWith(h.env);
    cleanupHarness(h);
  });

  it.each([
    "acquisition",
    "missing binary",
    "preflight",
    "cwd",
    "constructor",
    "nonzero result",
    "decoder",
    "server",
  ] as const)("cleans exactly once after %s failure", async (failure) => {
    const h = harness();
    if (failure === "acquisition") {
      h.prepareSubscriptionEnv.mockResolvedValue({
        env: h.env,
        error: "unavailable",
      });
    } else if (failure === "missing binary") {
      h.resolveSubscriptionAgentBin.mockReturnValue(null);
    } else if (failure === "preflight") {
      h.verifyCodexSubscriptionPreflight.mockReturnValue({ error: "bad receipt" });
    } else if (failure === "cwd") {
      h.createControllerCwd.mockImplementation(() => {
        throw new Error("cwd failed");
      });
    } else if (failure === "constructor") {
      h.createAppServer.mockImplementation(() => {
        throw new Error("constructor failed");
      });
    } else if (failure === "nonzero result") {
      h.runTurn.mockResolvedValue({
        finalText: "",
        threadId: "thread",
        code: 7,
        stderr: "sensitive detail",
      });
    } else if (failure === "decoder") {
      h.runTurn.mockResolvedValue({
        finalText: "not one envelope",
        threadId: "thread",
        code: 0,
        stderr: "",
      });
    } else {
      h.runTurn.mockRejectedValue(new Error("server failed"));
    }

    await expect(model(h).doGenerate(call())).rejects.toThrow();
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledOnce();
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledWith(h.env);
    const serverCreated = ["nonzero result", "decoder", "server"].includes(failure);
    expect(h.stop).toHaveBeenCalledTimes(serverCreated ? 1 : 0);
    const cwdCreated = ["constructor", "nonzero result", "decoder", "server"].includes(failure);
    expect(h.removeControllerCwd).toHaveBeenCalledTimes(cwdCreated ? 1 : 0);
    expect(h.runTurn).toHaveBeenCalledTimes(serverCreated ? 1 : 0);
    cleanupHarness(h);
  });

  it("does not let cleanup failures mask success or the primary error", async () => {
    const success = harness();
    success.cleanupSubscriptionHome.mockReturnValue(false);
    success.stop.mockImplementation(() => {
      throw new Error("stop cleanup failed");
    });
    success.removeControllerCwd.mockImplementation(() => {
      throw new Error("cwd cleanup failed");
    });
    await expect(model(success).doGenerate(call())).resolves.toMatchObject({
      finishReason: "stop",
    });
    cleanupHarness(success);

    const failure = harness();
    const primary = new Error("primary server failure");
    failure.runTurn.mockRejectedValue(primary);
    failure.cleanupSubscriptionHome.mockImplementation(() => {
      throw new Error("auth cleanup failed");
    });
    await expect(model(failure).doGenerate(call())).rejects.toBe(primary);
    cleanupHarness(failure);
  });

  it("aborts only its active server, removes its listener, and never replays", async () => {
    const h = harness();
    let rejectTurn: (reason: unknown) => void = () => undefined;
    h.runTurn.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectTurn = reject;
    }));
    h.stop.mockImplementation(() => {
      rejectTurn(new Error("server stopped"));
    });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = model(h).doGenerate(call({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(add).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.runTurn).toHaveBeenCalledOnce();
    expect(h.createAppServer).toHaveBeenCalledOnce();
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledOnce();
    cleanupHarness(h);
  });

  it("does not stop a concurrent sibling call when one signal aborts", async () => {
    const h = harness();
    const rejecters: Array<(reason: unknown) => void> = [];
    const resolvers: Array<(result: {
      finalText: string;
      threadId: string;
      code: number;
      stderr: string;
    }) => void> = [];
    const turns = [0, 1].map(() => vi.fn<AppServer["runTurn"]>(() =>
      new Promise((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      })
    ));
    const stops = [0, 1].map((index) => vi.fn<AppServer["stop"]>(() => {
      rejecters[index]?.(new Error(`server ${index} stopped`));
    }));
    let serverIndex = 0;
    h.createAppServer.mockImplementation(() => {
      const index = serverIndex;
      serverIndex += 1;
      return { runTurn: turns[index]!, stop: stops[index]! };
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const value = model(h);
    const first = value.doGenerate(call({ abortSignal: firstController.signal }));
    const second = value.doGenerate(call({ abortSignal: secondController.signal }));
    await vi.waitFor(() => expect(serverIndex).toBe(2));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).not.toHaveBeenCalled();
    resolvers[1]?.({
      finalText: "{\"kind\":\"text\",\"text\":\"sibling ready\"}",
      threadId: "sibling-thread",
      code: 0,
      stderr: "",
    });
    await expect(second).resolves.toMatchObject({
      content: [{ type: "text", text: "sibling ready" }],
    });
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(h.cleanupSubscriptionHome).toHaveBeenCalledTimes(2);
    cleanupHarness(h);
  });

  it("preserves an outcome-unknown error object even when abort stops the call", async () => {
    const h = harness();
    const uncertain = new CodexRequestOutcomeUnknownError("turn/start");
    let rejectTurn: (reason: unknown) => void = () => undefined;
    h.runTurn.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectTurn = reject;
    }));
    h.stop.mockImplementation(() => {
      rejectTurn(uncertain);
    });
    const controller = new AbortController();
    const pending = model(h).doGenerate(call({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toBe(uncertain);
    expect(h.runTurn).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
    cleanupHarness(h);
  });

  it("keeps prohibited provider and network fallbacks out of source and tests", () => {
    const source = [
      readFileSync(new URL("./codex-subscription-model.ts", import.meta.url), "utf8"),
      readFileSync(new URL(import.meta.url), "utf8"),
    ].join("\n");
    const needles = [
      ["OPENAI", "API_KEY"].join("_"),
      ["api.", "openai.com"].join(""),
      ["model", "-router"].join(""),
      ["fe", "tch("].join(""),
    ];
    for (const needle of needles) {
      expect(source).not.toContain(needle);
    }
  });
});
