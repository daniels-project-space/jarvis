export const TOOL_INVOCATION_ID_MAX_LENGTH = 120;

export type ToolInvocationContext = Readonly<{
  requestId?: string;
  userMessageId?: string;
}>;

export type ToolExecutionHostContext = Readonly<{
  authTokenHash?: string;
  invocationContext?: ToolInvocationContext;
}>;

type NormalizeToolInvocationContextOptions = {
  allowUserMessageId?: boolean;
};

function boundedIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > TOOL_INVOCATION_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function normalizeToolInvocationContext(
  value: unknown,
  options: NormalizeToolInvocationContextOptions = {},
): ToolInvocationContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool invocation context must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "requestId" && key !== "userMessageId")) {
    throw new Error("tool invocation context contains unknown fields");
  }
  if (!options.allowUserMessageId && input.userMessageId !== undefined) {
    throw new Error("user message provenance is not accepted from this caller");
  }
  const requestId = boundedIdentifier(input.requestId, "requestId");
  const userMessageId = options.allowUserMessageId
    ? boundedIdentifier(input.userMessageId, "userMessageId")
    : undefined;
  if (!requestId && !userMessageId) return undefined;
  return Object.freeze({
    ...(requestId ? { requestId } : {}),
    ...(userMessageId ? { userMessageId } : {}),
  });
}
