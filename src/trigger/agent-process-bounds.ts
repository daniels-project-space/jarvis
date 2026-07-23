import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_PROCESS_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export type ProcessStreamName = "stdout" | "stderr";
export type BoundedProcessFailureReason =
  | "invalid_limits"
  | "stdin_limit"
  | "spawn_failed"
  | "stdin_failed"
  | "stdout_bytes"
  | "stdout_chunks"
  | "stdout_lines"
  | "stderr_bytes"
  | "stderr_chunks"
  | "stderr_lines"
  | "stdout_failed"
  | "stderr_failed"
  | "protocol_invalid"
  | "process_exit"
  | "timeout"
  | "aborted";

/**
 * Process-boundary failures never contain argv, output, environment values, or
 * abort reasons. Callers can persist the typed reason without leaking command
 * data or incorrectly treating a partial provider/Git operation as successful.
 */
export class BoundedProcessError extends Error {
  readonly code = "jarvis_bounded_process_failed";
  readonly disposition = "failed_closed";
  readonly retrySafe = false;

  constructor(readonly reason: BoundedProcessFailureReason) {
    super(`bounded child process failed closed (${reason})`);
    this.name = "BoundedProcessError";
  }
}

export type BoundedStreamLimits = Readonly<{
  maxBytes: number;
  maxChunks: number;
  maxLines: number;
  retain: "all" | "none" | Readonly<{ tailBytes: number }>;
}>;

export type BoundedStreamMetrics = Readonly<{
  bytes: number;
  chunks: number;
  lines: number;
}>;

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateStreamLimits(limits: BoundedStreamLimits): void {
  if (!positiveSafeInteger(limits.maxBytes)
    || !positiveSafeInteger(limits.maxChunks)
    || !positiveSafeInteger(limits.maxLines)
    || (typeof limits.retain === "object"
      && (!Number.isSafeInteger(limits.retain.tailBytes)
        || limits.retain.tailBytes < 0
        || limits.retain.tailBytes > limits.maxBytes))) {
    throw new BoundedProcessError("invalid_limits");
  }
}

/** A cumulative byte/chunk/line budget that checks before retaining data. */
export class BoundedStreamCollector {
  private byteCount = 0;
  private chunkCount = 0;
  private completedLines = 0;
  private openLine = false;
  private readonly retainedChunks: Buffer[] = [];
  private retainedTail = Buffer.alloc(0);

  constructor(
    private readonly stream: ProcessStreamName,
    private readonly limits: BoundedStreamLimits,
  ) {
    validateStreamLimits(limits);
  }

  append(value: Uint8Array | string): void {
    const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if (!chunk.byteLength) return;

    const nextBytes = this.byteCount + chunk.byteLength;
    const nextChunks = this.chunkCount + 1;
    if (!Number.isSafeInteger(nextBytes) || nextBytes > this.limits.maxBytes) {
      throw new BoundedProcessError(`${this.stream}_bytes`);
    }
    if (nextChunks > this.limits.maxChunks) {
      throw new BoundedProcessError(`${this.stream}_chunks`);
    }

    let nextCompletedLines = this.completedLines;
    let nextOpenLine = this.openLine;
    for (const byte of chunk) {
      if (byte === 0x0a) {
        nextCompletedLines += 1;
        nextOpenLine = false;
      } else {
        nextOpenLine = true;
      }
    }
    const nextLines = nextCompletedLines + (nextOpenLine ? 1 : 0);
    if (!Number.isSafeInteger(nextLines) || nextLines > this.limits.maxLines) {
      throw new BoundedProcessError(`${this.stream}_lines`);
    }

    this.byteCount = nextBytes;
    this.chunkCount = nextChunks;
    this.completedLines = nextCompletedLines;
    this.openLine = nextOpenLine;

    if (this.limits.retain === "none") return;
    if (this.limits.retain === "all") {
      this.retainedChunks.push(chunk);
      return;
    }

    const maximum = this.limits.retain.tailBytes;
    if (maximum === 0) return;
    if (chunk.byteLength >= maximum) {
      this.retainedTail = Buffer.from(chunk.subarray(chunk.byteLength - maximum));
      return;
    }
    const retainedPrefixBytes = Math.min(this.retainedTail.byteLength, maximum - chunk.byteLength);
    const prefix = this.retainedTail.subarray(this.retainedTail.byteLength - retainedPrefixBytes);
    this.retainedTail = Buffer.concat([prefix, chunk], retainedPrefixBytes + chunk.byteLength);
  }

  buffer(): Buffer {
    if (this.limits.retain === "none") return Buffer.alloc(0);
    if (this.limits.retain === "all") return Buffer.concat(this.retainedChunks, this.byteCount);
    return Buffer.from(this.retainedTail);
  }

  text(): string {
    return this.buffer().toString("utf8");
  }

  metrics(): BoundedStreamMetrics {
    return Object.freeze({
      bytes: this.byteCount,
      chunks: this.chunkCount,
      lines: this.completedLines + (this.openLine ? 1 : 0),
    });
  }
}

export type BoundedProcessOptions = Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string | Uint8Array;
  maxInputBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  stdout: BoundedStreamLimits;
  stderr: BoundedStreamLimits;
  killGraceMs?: number;
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
  onStdoutEnd?: () => void;
}>;

export type BoundedProcessResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutMetrics: BoundedStreamMetrics;
  stderrMetrics: BoundedStreamMetrics;
}>;

function processFailure(error: unknown, fallback: BoundedProcessFailureReason): BoundedProcessError {
  return error instanceof BoundedProcessError ? error : new BoundedProcessError(fallback);
}

/**
 * Run one child under cumulative stream budgets. Limit, timeout, abort, stream,
 * protocol, and stdin failures kill the child and reject only after close (or
 * a short kill grace), so authority directories are not cleaned up underneath
 * a still-running subscription parent.
 */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    const input = options.input === undefined
      ? undefined
      : typeof options.input === "string"
        ? Buffer.from(options.input, "utf8")
        : Buffer.from(options.input);
    if (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 0
      || (input?.byteLength ?? 0) > options.maxInputBytes
      || !positiveSafeInteger(options.timeoutMs)
      || options.timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
      reject(new BoundedProcessError((input?.byteLength ?? 0) > options.maxInputBytes ? "stdin_limit" : "invalid_limits"));
      return;
    }
    if (options.signal?.aborted) {
      reject(new BoundedProcessError("aborted"));
      return;
    }

    let stdout: BoundedStreamCollector;
    let stderr: BoundedStreamCollector;
    try {
      stdout = new BoundedStreamCollector("stdout", options.stdout);
      stderr = new BoundedStreamCollector("stderr", options.stderr);
    } catch (error) {
      reject(processFailure(error, "invalid_limits"));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new BoundedProcessError("spawn_failed"));
      return;
    }

    let settled = false;
    let terminalFailure: BoundedProcessError | null = null;
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    const settleFailure = (failure: BoundedProcessError) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(failure);
    };
    const fail = (failure: BoundedProcessError) => {
      if (settled || terminalFailure) return;
      terminalFailure = failure;
      try { child.kill("SIGKILL"); } catch { /* process already gone */ }
      const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      killGraceTimer = setTimeout(() => settleFailure(failure), Math.max(1, grace));
    };
    const abort = () => fail(new BoundedProcessError("aborted"));

    const timeoutTimer = setTimeout(() => fail(new BoundedProcessError("timeout")), options.timeoutMs);
    timeoutTimer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (data: Buffer) => {
      if (terminalFailure || settled) return;
      try {
        stdout.append(data);
        options.onStdoutChunk?.(Buffer.from(data));
      } catch (error) {
        fail(processFailure(error, "protocol_invalid"));
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      if (terminalFailure || settled) return;
      try {
        stderr.append(data);
        options.onStderrChunk?.(Buffer.from(data));
      } catch (error) {
        fail(processFailure(error, "protocol_invalid"));
      }
    });
    child.stdout.once("end", () => {
      if (terminalFailure || settled) return;
      try {
        options.onStdoutEnd?.();
      } catch (error) {
        fail(processFailure(error, "protocol_invalid"));
      }
    });
    child.stdout.once("error", () => fail(new BoundedProcessError("stdout_failed")));
    child.stderr.once("error", () => fail(new BoundedProcessError("stderr_failed")));
    child.stdin.once("error", () => fail(new BoundedProcessError("stdin_failed")));
    child.once("error", () => fail(new BoundedProcessError("spawn_failed")));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (terminalFailure) {
        settleFailure(terminalFailure);
        return;
      }
      settled = true;
      cleanup();
      resolve(Object.freeze({
        code,
        signal,
        stdout: stdout.buffer(),
        stderr: stderr.buffer(),
        stdoutMetrics: stdout.metrics(),
        stderrMetrics: stderr.metrics(),
      }));
    });

    try {
      child.stdin.end(input);
    } catch {
      fail(new BoundedProcessError("stdin_failed"));
    }
  });
}
