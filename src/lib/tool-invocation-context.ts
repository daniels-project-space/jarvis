export const TOOL_INVOCATION_ID_MAX_LENGTH = 120;

export type ToolInvocationContext = Readonly<{
  requestId?: string;
  userMessageId?: string;
}>;

// Browser errands are different from ordinary foreground tools: a run is a
// consequential, single-use operation. The receipt key is created only after
// the foreground-owner endpoint has verified and atomically redeemed the
// signed owner receipt. It is intentionally host context, never a model tool
// argument or a browser/client request field.
export type ForegroundBrowserErrandExecution = Readonly<{
  receiptKey: string;
}>;

export type ToolExecutionHostContext = Readonly<{
  authTokenHash?: string;
  invocationContext?: ToolInvocationContext;
  foregroundBrowserErrandExecution?: ForegroundBrowserErrandExecution;
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

const FOREGROUND_BROWSER_RECEIPT_KEY_MAX_LENGTH = 512;
const FOREGROUND_BROWSER_RECEIPT_KEY = /^[A-Za-z0-9_.:-]{1,512}$/;

export function normalizeForegroundBrowserErrandExecution(
  value: unknown,
): ForegroundBrowserErrandExecution | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("foreground browser errand execution must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || input.receiptKey === undefined) {
    throw new Error("foreground browser errand execution contains unknown fields");
  }
  if (
    typeof input.receiptKey !== "string"
    || input.receiptKey.length > FOREGROUND_BROWSER_RECEIPT_KEY_MAX_LENGTH
    || !FOREGROUND_BROWSER_RECEIPT_KEY.test(input.receiptKey)
  ) {
    throw new Error("foreground browser errand receipt is invalid");
  }
  return Object.freeze({ receiptKey: input.receiptKey });
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
