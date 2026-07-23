import { parseStrictJson } from "./bounded-json";

/** Incremental JSONL decoder with a hard cap before UTF-8 or JSON parsing. */
export class BoundedJsonLineDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly maximumLineBytes: number) {
    if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1) {
      throw new Error("invalid JSONL limit");
    }
  }

  push(chunk: Uint8Array | string): unknown[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.pending = this.pending.byteLength ? Buffer.concat([this.pending, bytes]) : bytes;
    const messages: unknown[] = [];
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (!line.byteLength) continue;
      if (line.byteLength > this.maximumLineBytes) throw new Error("JSONL message too large");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      messages.push(parseStrictJson(text));
    }
    if (this.pending.byteLength > this.maximumLineBytes) throw new Error("JSONL message too large");
    return messages;
  }

  finish(): void {
    if (this.pending.byteLength) throw new Error("truncated JSONL message");
  }
}
