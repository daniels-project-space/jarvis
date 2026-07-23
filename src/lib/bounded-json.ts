type JsonRecord = Record<string, unknown>;

/**
 * JSON.parse accepts duplicate object keys and silently keeps the last value.
 * Security-sensitive protocols need one unambiguous representation, so scan
 * the complete grammar before parsing.
 */
export function rejectDuplicateJsonKeys(input: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(input[index] ?? "")) index += 1; };
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
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (input[index] === "}") { index += 1; return; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error("duplicate JSON key");
        keys.add(key);
        whitespace();
        if (input[index++] !== ":") fail();
        value();
        whitespace();
        if (input[index] === "}") { index += 1; return; }
        if (input[index++] !== ",") fail();
      }
    }
    if (input[index] === "[") {
      index += 1;
      whitespace();
      if (input[index] === "]") { index += 1; return; }
      while (true) {
        value();
        whitespace();
        if (input[index] === "]") { index += 1; return; }
        if (input[index++] !== ",") fail();
      }
    }
    const start = index;
    while (index < input.length && !/[\s,}\]]/.test(input[index])) index += 1;
    if (start === index) fail();
    JSON.parse(input.slice(start, index));
  };
  value();
  whitespace();
  if (index !== input.length) fail();
}

export function parseStrictJson(input: string): unknown {
  rejectDuplicateJsonKeys(input);
  return JSON.parse(input) as unknown;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key))
    && actual.length >= required.length
    && actual.length <= allowed.size;
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("invalid response limit");
  const declared = response.headers.get("content-length");
  let declaredLength: number | null = null;
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared)) throw new Error("invalid response length");
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length > maximumBytes) throw new Error("response too large");
    declaredLength = length;
  }
  if (!response.body) {
    if (declaredLength !== null && declaredLength !== 0) throw new Error("response length mismatch");
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declaredLength !== null && declaredLength !== received) throw new Error("response length mismatch");
  return output;
}

export async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedResponseBytes(response, maximumBytes));
}

export async function readBoundedResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("invalid JSON response type");
  return parseStrictJson(await readBoundedResponseText(response, maximumBytes));
}

export function assertExactResponseOrigin(response: Response, expectedOrigin: string): void {
  let origin: string;
  try {
    origin = new URL(response.url).origin;
  } catch {
    throw new Error("response origin unavailable");
  }
  if (origin !== expectedOrigin) throw new Error("response origin rejected");
}
