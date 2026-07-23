import Ajv, { type ValidateFunction } from "ajv";
import { isProxy } from "node:util/types";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2ProviderDefinedTool,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonArray;
interface JsonObject {
  readonly [key: string]: JsonValue;
}
interface JsonArray extends ReadonlyArray<JsonValue> {}

type FunctionSchema = LanguageModelV2FunctionTool["inputSchema"];
type UnsupportedSettingWarning = Extract<
  LanguageModelV2CallWarning,
  { type: "unsupported-setting" }
>;
type UnsupportedToolWarning = Extract<
  LanguageModelV2CallWarning,
  { type: "unsupported-tool" }
>;
type DecodedGenerateResult = Pick<
  Awaited<ReturnType<LanguageModelV2["doGenerate"]>>,
  "content" | "finishReason" | "usage" | "warnings" | "response"
>;

const MAX_MESSAGES = 128;
const MAX_PARTS = 512;
const MAX_TOOLS = 32;
const MAX_NAME_BYTES = 128;
const MAX_DESCRIPTION_BYTES = 4096;
const MAX_TEXT_BYTES = 48 * 1024;
const MAX_PROMPT_BYTES = 192 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_ALL_SCHEMAS_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_JSON_ARRAY = 1024;
const MAX_JSON_KEYS = 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 16384;
const namePattern = /^[A-Za-z0-9_.-]+$/;

interface OfferedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly validator: ValidateFunction;
}

interface ResponseFormatState {
  readonly responseFormat: "text" | "json";
  readonly name?: string;
  readonly description?: string;
  readonly responseSchema?: JsonObject;
  readonly validator?: ValidateFunction;
}

interface DecodeState {
  readonly tools: readonly OfferedTool[];
  readonly choice: JsonObject;
  readonly responseFormat: ResponseFormatState;
  readonly envelopeValidator: ValidateFunction;
  readonly warnings: LanguageModelV2CallWarning[];
}

export interface DecodedCodexSubscriptionResult extends DecodedGenerateResult {
  readonly content: LanguageModelV2Content[];
  readonly finishReason: LanguageModelV2FinishReason;
  readonly usage: LanguageModelV2Usage;
  readonly warnings: LanguageModelV2CallWarning[];
}

export interface PreparedCodexSubscriptionCall {
  readonly promptText: string;
  readonly outputSchema: JsonObject;
  readonly warnings: LanguageModelV2CallWarning[];
  decode(
    output: string,
    createToolCallId: () => string,
  ): DecodedCodexSubscriptionResult;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fail(message: string): never {
  throw new Error(`Codex subscription codec: ${message}`);
}

function property(
  object: object,
  key: string,
): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(object, key);
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): { readonly [key: string]: unknown } {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not have symbol keys`);
  }
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > MAX_JSON_KEYS) {
    fail(`${label} has too many keys`);
  }
  for (const key of keys) {
    const descriptor = property(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(`${label}.${key} must be an ordinary enumerable data property`);
    }
    if (!allowed.includes(key)) {
      fail(`${label}.${key} is unsupported`);
    }
  }
  const result = Object.create(null) as { [key: string]: unknown };
  for (const key of keys) {
    const descriptor = property(value, key);
    if (descriptor === undefined) {
      fail(`${label}.${key} is missing`);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}

function requiredString(
  object: { readonly [key: string]: unknown },
  key: string,
  label: string,
  maximum = MAX_TEXT_BYTES,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    fail(`${label}.${key} must be a string`);
  }
  if (byteLength(value) > maximum) {
    fail(`${label}.${key} exceeds its byte limit`);
  }
  return value;
}

function optionalString(
  object: { readonly [key: string]: unknown },
  key: string,
  label: string,
  maximum = MAX_TEXT_BYTES,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    return undefined;
  }
  return requiredString(object, key, label, maximum);
}

function put(object: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function jsonObject(): { [key: string]: JsonValue } {
  return Object.create(null) as { [key: string]: JsonValue };
}

function denseArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be an ordinary dense array`);
  }
  const lengthDescriptor = property(value, "length");
  if (
    lengthDescriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
    lengthDescriptor.writable !== true ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false
  ) {
    fail(`${label} has a custom length descriptor`);
  }
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length !== value.length
  ) {
    fail(`${label} has a custom length descriptor`);
  }
  if (length > maximum) {
    fail(`${label} has too many items`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not have symbol keys`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1) {
    fail(`${label} must not have holes or extra properties`);
  }
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = property(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !descriptor.writable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(`${label}[${index}] must be an ordinary data property`);
    }
  }
  return value;
}

function safeJson(value: unknown, label: string): JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (current: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      fail(`${label} has too many JSON nodes`);
    }
    if (depth > MAX_JSON_DEPTH) {
      fail(`${label} is too deeply nested`);
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail(`${label} contains a non-finite number`);
      }
      return current;
    }
    if (
      typeof current === "undefined" ||
      typeof current === "function" ||
      typeof current === "bigint" ||
      typeof current === "symbol"
    ) {
      fail(`${label} contains a non-JSON value`);
    }
    if (typeof current !== "object" || isProxy(current)) {
      fail(`${label} is not JSON data`);
    }
    if (seen.has(current)) {
      fail(`${label} contains a cycle`);
    }
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const values = denseArray(current, MAX_JSON_ARRAY, label);
        const result: JsonValue[] = [];
        for (let index = 0; index < values.length; index += 1) {
          result.push(copy(values[index], depth + 1));
        }
        return result;
      }
      if (
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      ) {
        fail(`${label} contains a non-plain object`);
      }
      if (Object.getOwnPropertySymbols(current).length !== 0) {
        fail(`${label} contains symbol keys`);
      }
      const keys = Object.getOwnPropertyNames(current);
      if (keys.length > MAX_JSON_KEYS) {
        fail(`${label} has too many object keys`);
      }
      keys.sort();
      const result = jsonObject();
      for (const key of keys) {
        const descriptor = property(current, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !descriptor.configurable ||
          !descriptor.writable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
          fail(`${label}.${key} must be an ordinary enumerable data property`);
        }
        put(result, key, copy(descriptor.value, depth + 1));
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };
  return copy(value, 0);
}

function asJsonObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function canonical(value: JsonValue, limit: number, label: string): string {
  const result = JSON.stringify(value);
  if (byteLength(result) > limit) {
    fail(`${label} exceeds its byte limit`);
  }
  return result;
}

function checkedName(value: string, label: string): string {
  if (
    value.length === 0 ||
    byteLength(value) > MAX_NAME_BYTES ||
    !namePattern.test(value)
  ) {
    fail(`${label} must be a non-empty safe name`);
  }
  return value;
}

function warningSetting(
  setting: UnsupportedSettingWarning["setting"],
  details: string,
): UnsupportedSettingWarning {
  return { type: "unsupported-setting", setting, details };
}

function warningTool(
  tool: UnsupportedToolWarning["tool"],
  details: string,
): UnsupportedToolWarning {
  return { type: "unsupported-tool", tool, details };
}

function ajvInstance(): Ajv {
  return new Ajv({
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateSchema: true,
    validateFormats: false,
    allErrors: true,
    strict: true,
  });
}

function compile(ajv: Ajv, schema: JsonObject, label: string): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid schema";
    fail(`${label} is malformed: ${detail}`);
  }
}

function responseFormat(
  value: unknown,
  ajv: Ajv,
): ResponseFormatState {
  if (value === undefined) {
    return { responseFormat: "text" };
  }
  const raw = exactObject(value, ["type", "name", "description", "schema"], "responseFormat");
  const type = requiredString(raw, "type", "responseFormat", 16);
  const name = optionalString(raw, "name", "responseFormat", MAX_NAME_BYTES);
  if (name !== undefined) {
    checkedName(name, "responseFormat.name");
  }
  const description = optionalString(
    raw,
    "description",
    "responseFormat",
    MAX_DESCRIPTION_BYTES,
  );
  if (type === "text") {
    if (name !== undefined || description !== undefined || raw.schema !== undefined) {
      fail("responseFormat text must not contain JSON schema metadata");
    }
    return { responseFormat: "text" };
  }
  if (type !== "json") {
    fail("responseFormat.type must be text or json");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "schema")) {
    return { responseFormat: "json", name, description };
  }
  const schema = asJsonObject(safeJson(raw.schema, "responseFormat.schema"), "responseFormat.schema");
  canonical(schema, MAX_SCHEMA_BYTES, "responseFormat.schema");
  return {
    responseFormat: "json",
    name,
    description,
    responseSchema: schema,
    validator: compile(ajv, schema, "responseFormat.schema"),
  };
}

function canonicalPart(value: unknown, role: string, index: number): JsonObject {
  const label = `prompt[${index}]`;
  const first = exactObject(value, [
    "type",
    "text",
    "toolCallId",
    "toolName",
    "input",
    "output",
    "filename",
    "data",
    "mediaType",
    "providerOptions",
    "providerExecuted",
  ], label);
  const type = requiredString(first, "type", label, 32);
  if (type === "file") {
    fail(`${label} file/media content is unsupported`);
  }
  if (type === "text") {
    if (role !== "user" && role !== "assistant") {
      fail(`${label} text is disallowed for ${role}`);
    }
    const raw = exactObject(value, ["type", "text", "providerOptions"], label);
    const result = jsonObject();
    put(result, "type", "text");
    put(result, "text", requiredString(raw, "text", label));
    return result;
  }
  if (type === "reasoning") {
    if (role !== "assistant") {
      fail(`${label} reasoning is disallowed for ${role}`);
    }
    const raw = exactObject(value, ["type", "text", "providerOptions"], label);
    const result = jsonObject();
    put(result, "type", "reasoning");
    put(result, "text", requiredString(raw, "text", label));
    return result;
  }
  if (type === "tool-call") {
    if (role !== "assistant") {
      fail(`${label} tool-call is disallowed for ${role}`);
    }
    const raw = exactObject(value, [
      "type",
      "toolCallId",
      "toolName",
      "input",
      "providerOptions",
      "providerExecuted",
    ], label);
    const result = jsonObject();
    put(result, "type", "tool-call");
    put(result, "toolCallId", checkedName(requiredString(raw, "toolCallId", label, MAX_NAME_BYTES), `${label}.toolCallId`));
    put(result, "toolName", checkedName(requiredString(raw, "toolName", label, MAX_NAME_BYTES), `${label}.toolName`));
    put(result, "input", safeJson(raw.input, `${label}.input`));
    return result;
  }
  if (type === "tool-result") {
    if (role !== "assistant" && role !== "tool") {
      fail(`${label} tool-result is disallowed for ${role}`);
    }
    const raw = exactObject(value, [
      "type",
      "toolCallId",
      "toolName",
      "output",
      "providerOptions",
    ], label);
    const output = exactObject(raw.output, ["type", "value"], `${label}.output`);
    const outputType = requiredString(output, "type", `${label}.output`, 32);
    const resultOutput = jsonObject();
    if (outputType === "text" || outputType === "error-text") {
      put(resultOutput, "type", outputType);
      put(resultOutput, "value", requiredString(output, "value", `${label}.output`));
    } else if (outputType === "json" || outputType === "error-json") {
      put(resultOutput, "type", outputType);
      put(resultOutput, "value", safeJson(output.value, `${label}.output.value`));
    } else if (outputType === "content") {
      fail(`${label}.output content/media is unsupported`);
    } else {
      fail(`${label}.output.type is unsupported`);
    }
    const result = jsonObject();
    put(result, "type", "tool-result");
    put(result, "toolCallId", checkedName(requiredString(raw, "toolCallId", label, MAX_NAME_BYTES), `${label}.toolCallId`));
    put(result, "toolName", checkedName(requiredString(raw, "toolName", label, MAX_NAME_BYTES), `${label}.toolName`));
    put(result, "output", resultOutput);
    return result;
  }
  fail(`${label}.type is unsupported`);
}

function canonicalPrompt(prompt: unknown): JsonArray {
  const messages = denseArray(prompt, MAX_MESSAGES, "prompt");
  const result: JsonValue[] = [];
  let partCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const raw = exactObject(messages[index], ["role", "content", "providerOptions", "providerExecuted"], `prompt[${index}]`);
    const role = requiredString(raw, "role", `prompt[${index}]`, 16);
    const message = jsonObject();
    put(message, "role", role);
    if (role === "system") {
      put(message, "content", requiredString(raw, "content", `prompt[${index}]`));
    } else if (role === "user" || role === "assistant" || role === "tool") {
      const parts = denseArray(raw.content, MAX_PARTS - partCount, `prompt[${index}].content`);
      const content: JsonValue[] = [];
      for (const part of parts) {
        partCount += 1;
        if (partCount > MAX_PARTS) {
          fail("prompt has too many parts");
        }
        content.push(canonicalPart(part, role, index));
      }
      put(message, "content", content);
    } else {
      fail(`prompt[${index}].role is unsupported`);
    }
    result.push(message);
  }
  return result;
}

function isProviderDefinedTool(value: unknown): value is LanguageModelV2ProviderDefinedTool {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    return false;
  }
  const descriptor = property(value, "type");
  return descriptor !== undefined &&
    Object.prototype.hasOwnProperty.call(descriptor, "value") &&
    descriptor.value === "provider-defined";
}

function prepareTools(
  tools: unknown,
  ajv: Ajv,
  warnings: LanguageModelV2CallWarning[],
): OfferedTool[] {
  if (tools === undefined) {
    return [];
  }
  const values = denseArray(tools, MAX_TOOLS, "tools");
  const offered: OfferedTool[] = [];
  const names = new Set<string>();
  let schemaBytes = 0;
  for (let index = 0; index < values.length; index += 1) {
    const original = values[index];
    const raw = exactObject(original, ["type", "name", "description", "inputSchema", "id", "args"], `tools[${index}]`);
    const type = requiredString(raw, "type", `tools[${index}]`, 32);
    if (type === "provider-defined") {
      const id = requiredString(raw, "id", `tools[${index}]`, MAX_NAME_BYTES);
      const name = requiredString(raw, "name", `tools[${index}]`, MAX_NAME_BYTES);
      if (!/^[^.]+\.[^.]+$/.test(id) || !namePattern.test(name)) {
        fail(`tools[${index}] provider-defined fields are invalid`);
      }
      if (!Object.prototype.hasOwnProperty.call(raw, "args")) {
        fail(`tools[${index}].args is required`);
      }
      safeJson(raw.args, `tools[${index}].args`);
      if (!isProviderDefinedTool(original)) {
        fail(`tools[${index}].type is unsupported`);
      }
      warnings.push(warningTool(original, "Provider-defined tools are unavailable to Codex."));
      continue;
    }
    if (type !== "function") {
      fail(`tools[${index}].type is unsupported`);
    }
    const tool = exactObject(original, ["type", "name", "description", "inputSchema"], `tools[${index}]`);
    const name = checkedName(requiredString(tool, "name", `tools[${index}]`, MAX_NAME_BYTES), `tools[${index}].name`);
    if (names.has(name)) {
      fail(`duplicate tool name: ${name}`);
    }
    names.add(name);
    const description = optionalString(tool, "description", `tools[${index}]`, MAX_DESCRIPTION_BYTES);
    const schema = asJsonObject(safeJson(tool.inputSchema, `tools[${index}].inputSchema`), `tools[${index}].inputSchema`);
    const bytes = byteLength(canonical(schema, MAX_SCHEMA_BYTES, `tools[${index}].inputSchema`));
    schemaBytes += bytes;
    if (schemaBytes > MAX_ALL_SCHEMAS_BYTES) {
      fail("aggregate tool schemas exceed their byte limit");
    }
    offered.push({
      name,
      ...(description === undefined ? {} : { description }),
      inputSchema: schema,
      validator: compile(ajv, schema, `tools[${index}].inputSchema`),
    });
  }
  return offered;
}

function choiceState(
  value: unknown,
  tools: readonly OfferedTool[],
): JsonObject {
  const raw = value === undefined
    ? exactObject({ type: "auto" }, ["type"], "toolChoice")
    : exactObject(value, ["type", "toolName"], "toolChoice");
  const type = requiredString(raw, "type", "toolChoice", 16);
  const result = jsonObject();
  put(result, "type", type);
  if (type === "tool") {
    const toolName = checkedName(requiredString(raw, "toolName", "toolChoice", MAX_NAME_BYTES), "toolChoice.toolName");
    if (!tools.some((tool) => tool.name === toolName)) {
      fail(`toolChoice references unavailable tool: ${toolName}`);
    }
    put(result, "toolName", toolName);
  } else if (type !== "auto" && type !== "none" && type !== "required") {
    fail("toolChoice.type is unsupported");
  }
  if (type === "required" && tools.length === 0) {
    fail("toolChoice required has no offered function tools");
  }
  return result;
}

function outputSchema(
  tools: readonly OfferedTool[],
  choice: JsonObject,
): JsonObject {
  const branches: JsonValue[] = [];
  const choiceType = choice.type;
  const addText = choiceType === "auto" || choiceType === "none";
  if (addText) {
    const branch = jsonObject();
    put(branch, "type", "object");
    put(branch, "additionalProperties", false);
    put(branch, "required", ["kind", "text"]);
    const properties = jsonObject();
    const kind = jsonObject();
    put(kind, "const", "text");
    const text = jsonObject();
    put(text, "type", "string");
    put(properties, "kind", kind);
    put(properties, "text", text);
    put(branch, "properties", properties);
    branches.push(branch);
  }
  const selected = choiceType === "tool" ? choice.toolName : undefined;
  if (choiceType !== "none") {
    for (const tool of tools) {
      if (selected !== undefined && tool.name !== selected) {
        continue;
      }
      const branch = jsonObject();
      put(branch, "type", "object");
      put(branch, "additionalProperties", false);
      put(branch, "required", ["kind", "toolName", "input"]);
      const properties = jsonObject();
      const kind = jsonObject();
      put(kind, "const", "tool_call");
      const toolName = jsonObject();
      put(toolName, "const", tool.name);
      put(properties, "kind", kind);
      put(properties, "toolName", toolName);
      put(properties, "input", tool.inputSchema);
      put(branch, "properties", properties);
      branches.push(branch);
    }
  }
  if (branches.length === 0) {
    fail("output schema has no permitted branches");
  }
  const result = jsonObject();
  put(result, "oneOf", branches);
  return result;
}

function optionWarnings(
  options: { readonly [key: string]: unknown },
): LanguageModelV2CallWarning[] {
  const warnings: LanguageModelV2CallWarning[] = [];
  const values: Array<[UnsupportedSettingWarning["setting"], unknown]> = [
    ["maxOutputTokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["topP", options.topP],
    ["topK", options.topK],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["stopSequences", options.stopSequences],
    ["seed", options.seed],
  ];
  for (const [setting, value] of values) {
    if (value !== undefined) {
      warnings.push(warningSetting(setting, "Codex subscription runtime does not support this setting."));
    }
  }
  return warnings;
}

export function prepareCodexSubscriptionCall(
  options: LanguageModelV2CallOptions,
): PreparedCodexSubscriptionCall {
  const safeOptions = exactObject(options, [
    "abortSignal",
    "frequencyPenalty",
    "headers",
    "includeRawChunks",
    "maxOutputTokens",
    "presencePenalty",
    "prompt",
    "providerOptions",
    "responseFormat",
    "seed",
    "stopSequences",
    "temperature",
    "toolChoice",
    "tools",
    "topK",
    "topP",
  ], "call options");
  const ajv = ajvInstance();
  const warnings = optionWarnings(safeOptions);
  const offeredTools = prepareTools(safeOptions.tools, ajv, warnings);
  const choice = choiceState(safeOptions.toolChoice, offeredTools);
  const format = responseFormat(safeOptions.responseFormat, ajv);
  const history = canonicalPrompt(safeOptions.prompt);
  const prompt = jsonObject();
  put(prompt, "messages", history);
  put(prompt, "toolChoice", choice);
  put(prompt, "tools", offeredTools.map((tool) => {
    const item = jsonObject();
    put(item, "name", tool.name);
    if (tool.description !== undefined) {
      put(item, "description", tool.description);
    }
    put(item, "inputSchema", tool.inputSchema);
    return item;
  }));
  const response = jsonObject();
  put(response, "type", format.responseFormat);
  if (format.name !== undefined) {
    put(response, "name", format.name);
  }
  if (format.description !== undefined) {
    put(response, "description", format.description);
  }
  if (format.responseSchema !== undefined) {
    put(response, "schema", format.responseSchema);
  }
  put(prompt, "responseFormat", response);
  const promptText = canonical(prompt, MAX_PROMPT_BYTES, "prompt");
  const schema = outputSchema(offeredTools, choice);
  const envelopeValidator = compile(ajv, schema, "output envelope schema");
  const state: DecodeState = {
    tools: offeredTools,
    choice,
    responseFormat: format,
    envelopeValidator,
    warnings: [...warnings],
  };
  return {
    promptText,
    outputSchema: schema,
    warnings: [...warnings],
    decode(output, createToolCallId) {
      if (typeof output !== "string" || byteLength(output) > MAX_OUTPUT_BYTES) {
        fail("final output exceeds its byte limit");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(output);
      } catch {
        fail("final output must be exactly one JSON envelope");
      }
      if (!state.envelopeValidator(envelope)) {
        fail("final output does not match the output envelope schema");
      }
      const raw = exactObject(envelope, ["kind", "text", "toolName", "input"], "final output");
      const kind = requiredString(raw, "kind", "final output", 32);
      const usage: LanguageModelV2Usage = {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      };
      if (kind === "text") {
        if (state.choice.type === "required" || state.choice.type === "tool") {
          fail("text is forbidden by tool choice");
        }
        const text = requiredString(raw, "text", "final output");
        let outputText = text;
        if (state.responseFormat.responseFormat === "json") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            fail("JSON response text must be exactly one JSON value");
          }
          const copied = safeJson(parsed, "JSON response");
          if (
            state.responseFormat.validator !== undefined &&
            !state.responseFormat.validator(copied)
          ) {
            fail("JSON response does not match response schema");
          }
          outputText = canonical(copied, MAX_OUTPUT_BYTES, "JSON response");
        }
        const content: LanguageModelV2Content[] = [{ type: "text", text: outputText }];
        return {
          content,
          finishReason: "stop",
          usage,
          warnings: [...state.warnings],
        };
      }
      if (kind !== "tool_call") {
        fail("final output kind is unsupported");
      }
      const toolName = requiredString(raw, "toolName", "final output", MAX_NAME_BYTES);
      const tool = state.tools.find((candidate) => candidate.name === toolName);
      if (tool === undefined || !tool.validator(raw.input)) {
        fail("final output has an unknown tool or invalid tool input");
      }
      const callId = createToolCallId();
      checkedName(callId, "host tool call ID");
      const content: LanguageModelV2Content[] = [{
        type: "tool-call",
        toolCallId: callId,
        toolName,
        input: canonical(safeJson(raw.input, "tool input"), MAX_SCHEMA_BYTES, "tool input"),
      }];
      return {
        content,
        finishReason: "tool-calls",
        usage,
        warnings: [...state.warnings],
      };
    },
  };
}

export function codexSubscriptionStreamParts(
  result: DecodedCodexSubscriptionResult,
  responseId: string,
  modelId: string,
  timestamp = new Date(),
): LanguageModelV2StreamPart[] {
  checkedName(responseId, "response ID");
  if (result.content.length !== 1) {
    fail("stream conversion requires exactly one content item");
  }
  const content = result.content[0];
  const parts: LanguageModelV2StreamPart[] = [
    { type: "stream-start", warnings: result.warnings },
    { type: "response-metadata", id: responseId, modelId, timestamp },
  ];
  if (content.type === "text") {
    const id = `${responseId}.text`;
    parts.push({ type: "text-start", id });
    parts.push({ type: "text-delta", id, delta: content.text });
    parts.push({ type: "text-end", id });
  } else if (content.type === "tool-call") {
    parts.push(content);
  } else {
    fail("stream conversion supports only text or tool-call content");
  }
  parts.push({
    type: "finish",
    finishReason: result.finishReason,
    usage: result.usage,
  });
  return parts;
}
