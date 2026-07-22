import { createHash } from "node:crypto";

const AUTH_OUTER_KEYS = ["OPENAI_API_KEY", "auth_mode", "last_refresh", "tokens"] as const;
const AUTH_TOKEN_KEYS = ["access_token", "refresh_token", "id_token", "account_id"] as const;

export type ChatgptSubscriptionAuth = {
  OPENAI_API_KEY: null;
  auth_mode: "chatgpt";
  last_refresh: string;
  tokens: Record<(typeof AUTH_TOKEN_KEYS)[number], string>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: JsonObject, expected: readonly string[]): boolean {
  const expectedKeys = [...expected].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expectedKeys.length && actual.every((key, index) => key === expectedKeys[index]);
}

// JSON.parse accepts duplicate object keys using the last value. Reject them
// before parsing so a credential document has one unambiguous canonical form.
function rejectDuplicateJsonKeys(input: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(input[index] ?? "")) index++; };
  const fail = (): never => { throw new Error("invalid JSON"); };
  const string = (): string => {
    if (input[index++] !== '"') fail();
    const start = index - 1;
    while (index < input.length) {
      const char = input[index++];
      if (char === '"') return JSON.parse(input.slice(start, index)) as string;
      if (char === "\\") {
        const escape = input[index++];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) fail();
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(index, index + 4))) fail();
          index += 4;
        }
      } else if (char.charCodeAt(0) < 0x20) fail();
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (input[index] === '"') { string(); return; }
    if (input[index] === "{") {
      index++; whitespace();
      const keys = new Set<string>();
      if (input[index] === "}") { index++; return; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate JSON key");
        keys.add(key);
        whitespace();
        if (input[index++] !== ":") fail();
        value(); whitespace();
        if (input[index] === "}") { index++; return; }
        if (input[index++] !== ",") fail();
      }
    }
    if (input[index] === "[") {
      index++; whitespace();
      if (input[index] === "]") { index++; return; }
      while (true) {
        value(); whitespace();
        if (input[index] === "]") { index++; return; }
        if (input[index++] !== ",") fail();
      }
    }
    const start = index;
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index++;
    if (start === index) fail();
    JSON.parse(input.slice(start, index));
  };
  value(); whitespace();
  if (index !== input.length) fail();
}

function apiKeyShaped(value: string): boolean {
  return /^(?:sk|rk|pk|api)[_-]/i.test(value) || /(?:^|[_-])api[_-]?key/i.test(value);
}

function validLastRefresh(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/);
  if (!match) return false;
  const year = Number(match[1]);
  const parsed = Date.parse(value);
  if (year < 2020 || year > 2100 || !Number.isFinite(parsed)) return false;
  // Date.parse normalizes impossible calendar values such as February 30.
  return new Date(parsed).toISOString().startsWith(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`,
  );
}

export function parseChatgptSubscriptionAuthText(json: string): ChatgptSubscriptionAuth {
  rejectDuplicateJsonKeys(json);
  const parsed: unknown = JSON.parse(json);
  if (!isObject(parsed) || !sameKeys(parsed, AUTH_OUTER_KEYS)
    || parsed.OPENAI_API_KEY !== null
    || parsed.auth_mode !== "chatgpt"
    || !validLastRefresh(parsed.last_refresh)
    || !isObject(parsed.tokens) || !sameKeys(parsed.tokens, AUTH_TOKEN_KEYS)) {
    throw new Error("invalid Codex ChatGPT subscription auth schema");
  }
  const tokens = {} as ChatgptSubscriptionAuth["tokens"];
  for (const key of AUTH_TOKEN_KEYS) {
    const value = parsed.tokens[key];
    if (typeof value !== "string" || !value.trim() || apiKeyShaped(value)) {
      throw new Error("invalid Codex ChatGPT subscription token");
    }
    tokens[key] = value;
  }
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: parsed.last_refresh,
    tokens,
  };
}

export function parseChatgptSubscriptionAuth(encoded: string): ChatgptSubscriptionAuth {
  // Buffer otherwise accepts whitespace, URL-safe alphabets, and truncated
  // payloads. Controller bootstrap accepts only canonical padded base64.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("invalid canonical Codex subscription auth encoding");
  }
  const json = Buffer.from(encoded, "base64").toString("utf8");
  if (Buffer.from(json, "utf8").toString("base64") !== encoded) {
    throw new Error("invalid canonical Codex subscription auth encoding");
  }
  return parseChatgptSubscriptionAuthText(json);
}

export function canonicalAuthJson(auth: ChatgptSubscriptionAuth): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: auth.auth_mode,
    last_refresh: auth.last_refresh,
    tokens: {
      access_token: auth.tokens.access_token,
      refresh_token: auth.tokens.refresh_token,
      id_token: auth.tokens.id_token,
      account_id: auth.tokens.account_id,
    },
  });
}

function decodeJwtPayload(token: string): JsonObject | null {
  const pieces = token.split(".");
  if (pieces.length < 2 || !pieces[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8")) as unknown;
    return isObject(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function subscriptionAccessTokenExpiresAt(auth: ChatgptSubscriptionAuth): number {
  const exp = decodeJwtPayload(auth.tokens.access_token)?.exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) {
    throw new Error("Codex subscription access token has no valid expiry");
  }
  return exp * 1_000;
}

export function subscriptionAuthDigest(auth: ChatgptSubscriptionAuth): string {
  return createHash("sha256").update(canonicalAuthJson(auth)).digest("hex");
}

export const CONTROLLER_REFRESH_SENTINEL = "jarvis-controller-refresh-required";

/**
 * Codex 0.144.5's managed refresh endpoint may update `last_refresh` even when
 * a response omits one or more token fields. A controller publication needs a
 * stronger receipt: the same account, a strictly newer access credential, and
 * a new one-time refresh credential that covers the caller's whole window.
 */
export function isUsableManagedSessionRotation(
  current: ChatgptSubscriptionAuth,
  updated: ChatgptSubscriptionAuth,
  requiredUntil: number,
): boolean {
  if (!Number.isSafeInteger(requiredUntil) || requiredUntil <= 0) return false;
  let currentExpiry: number;
  let updatedExpiry: number;
  try {
    currentExpiry = subscriptionAccessTokenExpiresAt(current);
    updatedExpiry = subscriptionAccessTokenExpiresAt(updated);
  } catch {
    return false;
  }
  return updated.tokens.account_id === current.tokens.account_id
    && updated.tokens.access_token !== current.tokens.access_token
    && updatedExpiry > currentExpiry
    && updatedExpiry >= requiredUntil
    && updated.tokens.refresh_token !== current.tokens.refresh_token
    && updated.tokens.refresh_token !== CONTROLLER_REFRESH_SENTINEL;
}

/**
 * Workers receive a usable access snapshot but never the one-time refresh
 * state. If Codex reaches refresh, the sentinel fails harmlessly and the host
 * controller must reacquire a newer snapshot.
 */
export function consumerAuth(auth: ChatgptSubscriptionAuth): ChatgptSubscriptionAuth {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: auth.last_refresh,
    tokens: { ...auth.tokens, refresh_token: CONTROLLER_REFRESH_SENTINEL },
  };
}
