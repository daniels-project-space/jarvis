import { describe, expect, it } from "vitest";
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2ProviderDefinedTool,
} from "@ai-sdk/provider";
import type { DecodedCodexSubscriptionResult } from "./codex-subscription-codec";
import {
  codexSubscriptionStreamParts,
  prepareCodexSubscriptionCall,
} from "./codex-subscription-codec";

const tool = {
  type: "function",
  name: "weather",
  description: "Get a forecast",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["city"],
    properties: { city: { type: "string" } },
  },
} satisfies LanguageModelV2FunctionTool;

function call(overrides: Partial<LanguageModelV2CallOptions> = {}): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function uncheckedCall(value: unknown): LanguageModelV2CallOptions {
  return value as LanguageModelV2CallOptions;
}

function uncheckedFunctionTool(value: unknown): LanguageModelV2FunctionTool {
  return value as LanguageModelV2FunctionTool;
}

function resultWithContent(
  base: DecodedCodexSubscriptionResult,
  content: LanguageModelV2Content[],
): DecodedCodexSubscriptionResult {
  return { ...base, content };
}

function toolResultCall(output: unknown): LanguageModelV2CallOptions {
  return uncheckedCall({
    prompt: [{
      role: "assistant",
      content: [{
        type: "tool-result",
        toolCallId: "old-call",
        toolName: "weather",
        output,
      }],
    }],
  });
}

function hostileArrays(): unknown[] {
  const sparse: unknown[] = [];
  sparse[1] = "x";
  const customPrototype: unknown[] = [];
  Object.setPrototypeOf(customPrototype, null);
  const named: unknown[] = [];
  Object.defineProperty(named, "extra", {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const symbol: unknown[] = [];
  Object.defineProperty(symbol, Symbol("extra"), {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const fixedLength: unknown[] = [];
  Object.defineProperty(fixedLength, "length", { writable: false });
  return [new Proxy([], {}), sparse, customPrototype, named, symbol, fixedLength];
}

function branchConstants(schema: unknown): Array<[string, string | undefined]> {
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    !Array.isArray((schema as { oneOf?: unknown }).oneOf)
  ) {
    throw new Error("schema has no branches");
  }
  return (schema as { oneOf: unknown[] }).oneOf.map((branch) => {
    if (
      branch === null ||
      typeof branch !== "object" ||
      Array.isArray(branch) ||
      (branch as { properties?: unknown }).properties === null ||
      typeof (branch as { properties?: unknown }).properties !== "object"
    ) {
      throw new Error("invalid schema branch");
    }
    const properties = (branch as {
      properties: { kind?: unknown; toolName?: unknown };
    }).properties;
    const kind = properties.kind;
    const toolName = properties.toolName;
    if (
      kind === null ||
      typeof kind !== "object" ||
      Array.isArray(kind) ||
      typeof (kind as { const?: unknown }).const !== "string"
    ) {
      throw new Error("branch has no kind constant");
    }
    const tool = toolName !== null &&
      typeof toolName === "object" &&
      !Array.isArray(toolName) &&
      typeof (toolName as { const?: unknown }).const === "string"
      ? (toolName as { const: string }).const
      : undefined;
    return [(kind as { const: string }).const, tool];
  });
}

describe("codex subscription codec", () => {
  it("prepares text, auto, none, required, and specific branches", () => {
    expect(branchConstants(JSON.parse(json(
      prepareCodexSubscriptionCall(call()).outputSchema,
    )))).toEqual([["text", undefined]]);
    const auto = prepareCodexSubscriptionCall(call({ tools: [tool] }));
    expect(branchConstants(JSON.parse(json(auto.outputSchema)))).toEqual([
      ["text", undefined],
      ["tool_call", "weather"],
    ]);
    expect(branchConstants(JSON.parse(json(prepareCodexSubscriptionCall(call({
      tools: [tool],
      toolChoice: { type: "none" },
    })).outputSchema)))).toEqual([["text", undefined]]);
    expect(branchConstants(JSON.parse(json(prepareCodexSubscriptionCall(call({
      tools: [tool],
      toolChoice: { type: "required" },
    })).outputSchema)))).toEqual([["tool_call", "weather"]]);
    expect(branchConstants(JSON.parse(json(prepareCodexSubscriptionCall(call({
      tools: [tool],
      toolChoice: { type: "tool", toolName: "weather" },
    })).outputSchema)))).toEqual([["tool_call", "weather"]]);
    expect(() => prepareCodexSubscriptionCall(call({
      toolChoice: { type: "required" },
    }))).toThrow(/no offered/);
    expect(() => prepareCodexSubscriptionCall(call({
      tools: [tool],
      toolChoice: { type: "tool", toolName: "missing" },
    }))).toThrow(/unavailable/);
  });

  it("rejects invalid and duplicate tools and impossible choices", () => {
    for (const name of ["", "bad name", "x".repeat(129)]) {
      expect(() => prepareCodexSubscriptionCall(call({
        tools: [{ ...tool, name }],
      }))).toThrow(/name/);
    }
    expect(() => prepareCodexSubscriptionCall(call({
      tools: [tool, { ...tool }],
    }))).toThrow(/duplicate tool name/);

    const providerOnly = {
      type: "provider-defined",
      id: "vendor.search",
      name: "search",
      args: {},
    } satisfies LanguageModelV2ProviderDefinedTool;
    expect(() => prepareCodexSubscriptionCall(call({
      tools: [providerOnly],
      toolChoice: { type: "required" },
    }))).toThrow(/no offered/);
    expect(() => prepareCodexSubscriptionCall(call({
      tools: [tool],
      toolChoice: { type: "tool", toolName: "missing" },
    }))).toThrow(/unavailable/);
  });

  it("decodes only valid exact envelopes and generates host IDs", () => {
    const prepared = prepareCodexSubscriptionCall(call({ tools: [tool] }));
    let calls = 0;
    const decoded = prepared.decode(
      "{\"kind\":\"tool_call\",\"toolName\":\"weather\",\"input\":{\"city\":\"Oslo\"}}",
      () => {
        calls += 1;
        return "host-call";
      },
    );
    expect(decoded.content).toEqual([{
      type: "tool-call",
      toolCallId: "host-call",
      toolName: "weather",
      input: "{\"city\":\"Oslo\"}",
    }]);
    expect(decoded.finishReason).toBe("tool-calls");
    expect(calls).toBe(1);
    for (const output of [
      "{\"kind\":\"tool_call\",\"toolName\":\"missing\",\"input\":{}}",
      "{\"kind\":\"tool_call\",\"toolName\":\"weather\",\"input\":{}}",
      "```json\n{\"kind\":\"text\",\"text\":\"x\"}\n```",
      "{\"kind\":\"text\",\"text\":\"x\"} {\"kind\":\"text\",\"text\":\"y\"}",
    ]) {
      expect(() => prepared.decode(output, () => "host-call")).toThrow();
    }
  });

  it("does not allocate host IDs for bad output and validates allocated IDs", () => {
    const prepared = prepareCodexSubscriptionCall(call({ tools: [tool] }));
    let calls = 0;
    expect(() => prepared.decode(
      "{\"kind\":\"tool_call\",\"toolName\":\"weather\",\"input\":{}}",
      () => {
        calls += 1;
        return "unused";
      },
    )).toThrow();
    expect(calls).toBe(0);

    const valid = "{\"kind\":\"tool_call\",\"toolName\":\"weather\",\"input\":{\"city\":\"Oslo\"}}";
    for (const hostId of ["", "bad id", "x".repeat(129)]) {
      calls = 0;
      expect(() => prepared.decode(valid, () => {
        calls += 1;
        return hostId;
      })).toThrow(/host tool call ID/);
      expect(calls).toBe(1);
    }
  });

  it("canonicalizes JSON response text and validates its schema", () => {
    const prepared = prepareCodexSubscriptionCall(call({
      responseFormat: {
        type: "json",
        name: "answer",
        schema: {
          type: "object",
          required: ["ok"],
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
        },
      },
    }));
    expect(prepared.decode(
      "{\"kind\":\"text\",\"text\":\" {\\\"ok\\\":true} \"}",
      () => "unused",
    ).content).toEqual([{ type: "text", text: "{\"ok\":true}" }]);
    expect(() => prepared.decode(
      "{\"kind\":\"text\",\"text\":\"{}\"}",
      () => "unused",
    )).toThrow(/response schema/);
  });

  it("forbids text envelopes for required and specific tool choices", () => {
    for (const toolChoice of [
      { type: "required" as const },
      { type: "tool" as const, toolName: "weather" },
    ]) {
      const prepared = prepareCodexSubscriptionCall(call({ tools: [tool], toolChoice }));
      expect(() => prepared.decode(
        "{\"kind\":\"text\",\"text\":\"not allowed\"}",
        () => "unused",
      )).toThrow();
    }
  });

  it("retains supported history and excludes transport fields", () => {
    const prepared = prepareCodexSubscriptionCall(call({
      prompt: [
        { role: "system", content: "rules" },
        { role: "user", providerOptions: { ignored: { secret: "message-secret" } }, content: [
          { type: "text", text: "question", providerOptions: { ignored: { secret: "part-secret" } } },
        ] },
        { role: "assistant", content: [
          { type: "text", text: "answer" },
          { type: "reasoning", text: "think", providerOptions: { ignored: { secret: "reasoning-secret" } } },
          {
            type: "tool-call",
            toolCallId: "old",
            toolName: "weather",
            input: { city: "Paris" },
            providerExecuted: true,
            providerOptions: { ignored: { secret: "tool-secret" } },
          },
          { type: "tool-result", toolCallId: "old", toolName: "weather", output: { type: "json", value: { temp: 20 } } },
        ] },
        { role: "tool", content: [
          { type: "tool-result", toolCallId: "old", toolName: "weather", output: { type: "text", value: "sunny" } },
        ] },
      ],
    }));
    expect(prepared.promptText).toContain("\"city\":\"Paris\"");
    expect(prepared.promptText).not.toContain("providerOptions");
    expect(prepared.promptText).not.toContain("providerExecuted");
    expect(prepared.promptText).not.toContain("secret");
    expect(() => prepareCodexSubscriptionCall(call({
      prompt: [{ role: "user", content: [{
        type: "file",
        filename: "note.txt",
        data: "x",
        mediaType: "text/plain",
        providerOptions: { ignored: { secret: "file-secret" } },
      }] }],
    }))).toThrow(/file\/media content is unsupported/);
  });

  it("rejects unknown roles and disallowed role-part combinations", () => {
    const invalidPrompts: unknown[] = [
      [{ role: "unknown", content: [] }],
      [{ role: "system", content: [{ type: "text", text: "x" }] }],
      [{ role: "user", content: [{ type: "reasoning", text: "x" }] }],
      [{ role: "user", content: [{ type: "tool-call", toolCallId: "x", toolName: "weather", input: {} }] }],
      [{ role: "user", content: [{ type: "tool-result", toolCallId: "x", toolName: "weather", output: { type: "text", value: "x" } }] }],
      [{ role: "tool", content: [{ type: "text", text: "x" }] }],
      [{ role: "tool", content: [{ type: "reasoning", text: "x" }] }],
      [{ role: "assistant", content: [{ type: "unknown", text: "x" }] }],
    ];
    for (const prompt of invalidPrompts) {
      expect(() => prepareCodexSubscriptionCall(uncheckedCall({ prompt }))).toThrow();
    }
  });

  it("accepts the four non-media tool-result outputs and rejects the rest", () => {
    const accepted = [
      { type: "text", value: "ok" },
      { type: "error-text", value: "failed" },
      { type: "json", value: { ok: true } },
      { type: "error-json", value: { code: 7 } },
    ];
    for (const output of accepted) {
      expect(prepareCodexSubscriptionCall(toolResultCall(output)).promptText).toContain(output.type);
    }
    for (const output of [
      { type: "content", value: [{ type: "text", text: "media-capable" }] },
      { type: "unknown", value: "x" },
    ]) {
      expect(() => prepareCodexSubscriptionCall(toolResultCall(output))).toThrow(/output/);
    }
  });

  it("emits exact ordered text and tool streams without fabricated usage", () => {
    const text = prepareCodexSubscriptionCall(call({
      temperature: 0,
    })).decode("{\"kind\":\"text\",\"text\":\"hello\"}", () => "unused");
    const timestamp = new Date("2026-07-22T12:00:00.000Z");
    const textParts = codexSubscriptionStreamParts(text, "response-1", "codex", timestamp);
    expect(textParts.map((part) => part.type)).toEqual([
      "stream-start", "response-metadata", "text-start", "text-delta", "text-end", "finish",
    ]);
    expect(textParts[0]).toEqual({
      type: "stream-start",
      warnings: [{ type: "unsupported-setting", setting: "temperature", details: "Codex subscription runtime does not support this setting." }],
    });
    expect(textParts[1]).toEqual({
      type: "response-metadata",
      id: "response-1",
      modelId: "codex",
      timestamp,
    });
    expect(textParts.slice(2, 5)).toEqual([
      { type: "text-start", id: "response-1.text" },
      { type: "text-delta", id: "response-1.text", delta: "hello" },
      { type: "text-end", id: "response-1.text" },
    ]);
    expect(textParts.slice(1).every((part) => !("warnings" in part))).toBe(true);
    expect(text.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    const toolResult = prepareCodexSubscriptionCall(call({ tools: [tool] })).decode(
      "{\"kind\":\"tool_call\",\"toolName\":\"weather\",\"input\":{\"city\":\"Rome\"}}",
      () => "call-1",
    );
    const toolParts = codexSubscriptionStreamParts(toolResult, "response-2", "codex");
    expect(toolParts.map((part) => part.type)).toEqual([
      "stream-start", "response-metadata", "tool-call", "finish",
    ]);
    expect(toolParts[3]).toEqual({
      type: "finish",
      finishReason: "tool-calls",
      usage: toolResult.usage,
    });
    expect(toolParts[2]).toEqual({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "weather",
      input: "{\"city\":\"Rome\"}",
    });
  });

  it("rejects zero, multiple, and unsupported stream content", () => {
    const base = prepareCodexSubscriptionCall(call()).decode(
      "{\"kind\":\"text\",\"text\":\"hello\"}",
      () => "unused",
    );
    for (const content of [
      [],
      [base.content[0], base.content[0]],
      [{ type: "reasoning" as const, text: "hidden" }],
    ]) {
      expect(() => codexSubscriptionStreamParts(
        resultWithContent(base, content),
        "response-1",
        "codex",
      )).toThrow(/stream conversion/);
    }
  });

  it("warns for provider tools and documented unsupported settings", () => {
    const providerTool = {
      type: "provider-defined",
      id: "vendor.search",
      name: "search",
      args: {},
    } satisfies LanguageModelV2ProviderDefinedTool;
    const prepared = prepareCodexSubscriptionCall(call({
      tools: [providerTool],
      topK: 3,
    }));
    expect(prepared.warnings).toEqual([
      {
        type: "unsupported-setting",
        setting: "topK",
        details: "Codex subscription runtime does not support this setting.",
      },
      {
        type: "unsupported-tool",
        tool: providerTool,
        details: "Provider-defined tools are unavailable to Codex.",
      },
    ]);
    expect(prepared.promptText).not.toContain("vendor.search");
  });

  it("emits every documented unsupported-setting warning in stable order", () => {
    const prepared = prepareCodexSubscriptionCall(call({
      maxOutputTokens: 10,
      temperature: 0,
      topP: 0.9,
      topK: 2,
      presencePenalty: 0,
      frequencyPenalty: 0,
      stopSequences: ["stop"],
      seed: 7,
    }));
    expect(prepared.warnings.map((warning) =>
      warning.type === "unsupported-setting" ? warning.setting : warning.type
    )).toEqual([
      "maxOutputTokens",
      "temperature",
      "topP",
      "topK",
      "presencePenalty",
      "frequencyPenalty",
      "stopSequences",
      "seed",
    ]);
  });

  it("rejects hostile provider-defined tool arguments", () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "x";
      },
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const symbol = {};
    Object.defineProperty(symbol, Symbol("secret"), { value: true, enumerable: true });
    for (const args of [accessor, cyclic, symbol, new Proxy({}, {})]) {
      const providerTool = {
        type: "provider-defined",
        id: "vendor.search",
        name: "search",
        args,
      } as unknown as LanguageModelV2ProviderDefinedTool;
      expect(() => prepareCodexSubscriptionCall(call({ tools: [providerTool] }))).toThrow();
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects hostile JSON without invoking getters or toJSON", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "x", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "x";
      },
    });
    const withToJson = {
      toJSON() {
        toJsonCalls += 1;
        return {};
      },
    };
    const hostile = [
      accessor,
      withToJson,
      { x: undefined },
      { x: () => undefined },
      { x: BigInt(1) },
      { x: Number.NaN },
      new Date(),
    ];
    for (const input of hostile) {
      expect(() => prepareCodexSubscriptionCall(call({
        prompt: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "y", input }] }],
      }))).toThrow();
    }
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  it("rejects hostile call-option objects without invoking getters", () => {
    let getterCalls = 0;
    const accessor = call();
    Object.defineProperty(accessor, "temperature", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 0;
      },
    });
    const symbol = call();
    Object.defineProperty(symbol, Symbol("secret"), { value: true, enumerable: true });
    const customPrototype = call();
    Object.setPrototypeOf(customPrototype, { marker: true });
    const nonEnumerable = call();
    Object.defineProperty(nonEnumerable, "temperature", {
      value: 0,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const readOnly = call();
    Object.defineProperty(readOnly, "temperature", {
      value: 0,
      enumerable: true,
      configurable: true,
      writable: false,
    });
    const unknownKey = { ...call(), secret: true };
    for (const options of [
      new Proxy(call(), {}),
      accessor,
      symbol,
      customPrototype,
      nonEnumerable,
      readOnly,
      unknownKey,
    ]) {
      expect(() => prepareCodexSubscriptionCall(uncheckedCall(options))).toThrow();
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects hostile prompt, content, and tool arrays", () => {
    for (const array of hostileArrays()) {
      expect(() => prepareCodexSubscriptionCall(uncheckedCall({ prompt: array }))).toThrow();
      expect(() => prepareCodexSubscriptionCall(uncheckedCall({
        prompt: [{ role: "user", content: array }],
      }))).toThrow();
      expect(() => prepareCodexSubscriptionCall(uncheckedCall({
        prompt: call().prompt,
        tools: array,
      }))).toThrow();
    }
  });

  it("rejects cycles, proxies, symbols, sparse/custom arrays, depth, nodes, and bounds", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const symbolInput = { x: 1 };
    Object.defineProperty(symbolInput, Symbol("x"), { value: 1, enumerable: true });
    const sparse: unknown[] = [];
    sparse[1] = "x";
    const custom: unknown[] = [];
    Object.setPrototypeOf(custom, null);
    const deep: { x: unknown } = { x: null };
    let cursor = deep;
    for (let index = 0; index < 65; index += 1) {
      const next: { x: unknown } = { x: null };
      cursor.x = next;
      cursor = next;
    }
    const inputs = [cyclic, symbolInput, sparse, custom, deep, new Proxy({}, {})];
    for (const input of inputs) {
      expect(() => prepareCodexSubscriptionCall(call({
        prompt: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "y", input }] }],
      }))).toThrow();
    }
    expect(() => prepareCodexSubscriptionCall(call({
      prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(48 * 1024 + 1) }] }],
    }))).toThrow();
    expect(() => prepareCodexSubscriptionCall(call()).decode(
      "{\"kind\":\"text\",\"text\":\"" + "x".repeat(256 * 1024) + "\"}",
      () => "x",
    )).toThrow();
  });

  it("enforces schema, aggregate schema, prompt, JSON shape, and node limits", () => {
    expect(() => prepareCodexSubscriptionCall(uncheckedCall({
      prompt: call().prompt,
      responseFormat: { type: "json", schema: { type: "not-a-json-schema-type" } },
    }))).toThrow(/malformed/);

    expect(() => prepareCodexSubscriptionCall(call({
      tools: [uncheckedFunctionTool({
        ...tool,
        inputSchema: { type: "object", description: "x".repeat(33 * 1024) },
      })],
    }))).toThrow(/byte limit/);
    expect(() => prepareCodexSubscriptionCall(uncheckedCall({
      prompt: call().prompt,
      responseFormat: {
        type: "json",
        schema: { type: "object", description: "x".repeat(33 * 1024) },
      },
    }))).toThrow(/byte limit/);

    const aggregateTools = ["one", "two", "three"].map((name) =>
      uncheckedFunctionTool({
        ...tool,
        name,
        inputSchema: { type: "object", description: "x".repeat(22 * 1024) },
      })
    );
    expect(() => prepareCodexSubscriptionCall(call({ tools: aggregateTools }))).toThrow(/aggregate/);

    expect(() => prepareCodexSubscriptionCall(uncheckedCall({
      prompt: Array.from({ length: 5 }, (_, index) => ({
        role: "system",
        content: `${index}${"x".repeat(40 * 1024)}`,
      })),
    }))).toThrow(/prompt exceeds/);

    const tooManyKeys: { [key: string]: number } = {};
    for (let index = 0; index < 1025; index += 1) {
      tooManyKeys[`key${index}`] = index;
    }
    const tooLongArray = Array.from({ length: 1025 }, (_, index) => index);
    const nodeHeavy = Array.from({ length: 1024 }, (_, row) => {
      const item: { [key: string]: number } = {};
      for (let column = 0; column < 16; column += 1) {
        item[`column${column}`] = row + column;
      }
      return item;
    });
    for (const input of [tooManyKeys, tooLongArray, { rows: nodeHeavy }]) {
      expect(() => prepareCodexSubscriptionCall(uncheckedCall({
        prompt: [{
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "old",
            toolName: "weather",
            input,
          }],
        }],
      }))).toThrow();
    }
  });

  it("preserves an own __proto__ JSON key without prototype pollution", () => {
    const input = Object.create(null) as { [key: string]: unknown };
    Object.defineProperty(input, "__proto__", {
      value: { safe: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const prepared = prepareCodexSubscriptionCall(call({
      prompt: [{ role: "assistant", content: [{
        type: "tool-call",
        toolCallId: "old",
        toolName: "weather",
        input,
      }] }],
    }));
    expect(prepared.promptText).toContain("\"__proto__\"");
    expect((Object.prototype as { safe?: boolean }).safe).toBeUndefined();
  });
});
