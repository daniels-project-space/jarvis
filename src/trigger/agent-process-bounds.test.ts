import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BoundedProcessError,
  BoundedStreamCollector,
  runBoundedProcess,
  type BoundedProcessOptions,
  type BoundedStreamLimits,
} from "./agent-process-bounds";

const full = (overrides: Partial<BoundedStreamLimits> = {}): BoundedStreamLimits => ({
  maxBytes: 4_096,
  maxChunks: 64,
  maxLines: 64,
  retain: "all",
  ...overrides,
});

const processOptions = (script: string, overrides: Partial<BoundedProcessOptions> = {}): BoundedProcessOptions => ({
  command: process.execPath,
  args: ["-e", script],
  env: { ...process.env },
  maxInputBytes: 0,
  timeoutMs: 2_000,
  stdout: full(),
  stderr: full({ retain: { tailBytes: 32 } }),
  killGraceMs: 500,
  ...overrides,
});

describe("agent controller process bounds", () => {
  it("retains only a bounded stderr tail while tracking cumulative bytes, chunks, and lines", () => {
    const collector = new BoundedStreamCollector("stderr", full({ retain: { tailBytes: 4 } }));
    collector.append("one\n");
    collector.append("two");
    expect(collector.text()).toBe("\ntwo");
    expect(collector.metrics()).toEqual({ bytes: 7, chunks: 2, lines: 2 });
  });

  it.each([
    ["bytes", full({ maxBytes: 3 }), "four", "stdout_bytes", 0],
    ["chunks", full({ maxChunks: 1 }), ["a", "b"], "stdout_chunks", 1],
    ["lines", full({ maxLines: 1 }), "a\nb", "stdout_lines", 0],
  ] as const)("rejects stdout %s before retaining over-budget data", (_label, limits, values, reason, retainedBytes) => {
    const collector = new BoundedStreamCollector("stdout", limits);
    const chunks = typeof values === "string" ? [values] : values;
    expect(() => chunks.forEach((chunk) => collector.append(chunk))).toThrowError(
      expect.objectContaining({ code: "jarvis_bounded_process_failed", reason }),
    );
    expect(collector.buffer().byteLength).toBe(retainedBytes);
  });

  it("returns bounded stdout and a bounded stderr tail on normal exit", async () => {
    const result = await runBoundedProcess(processOptions(
      'process.stdout.write("ok\\n"); process.stderr.write("0123456789")',
      { stderr: full({ retain: { tailBytes: 4 } }) },
    ));
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("ok\n");
    expect(result.stderr.toString()).toBe("6789");
    expect(result.stderrMetrics.bytes).toBe(10);
  });

  it.each([
    ["stdout", 'process.stdout.write("x".repeat(8192))', { stdout: full({ maxBytes: 32 }) }, "stdout_bytes"],
    ["stderr", 'process.stderr.write("x".repeat(8192))', { stderr: full({ maxBytes: 32 }) }, "stderr_bytes"],
  ] as const)("kills the child and fails closed on cumulative %s overflow", async (_stream, script, overrides, reason) => {
    await expect(runBoundedProcess(processOptions(script, overrides))).rejects.toMatchObject({
      name: "BoundedProcessError",
      code: "jarvis_bounded_process_failed",
      disposition: "failed_closed",
      retrySafe: false,
      reason,
    });
  });

  it("kills and reaps a timed-out child before rejecting", async () => {
    let childPid = 0;
    await expect(runBoundedProcess(processOptions(
      "console.log(process.pid); setInterval(() => {}, 1000)",
      {
        timeoutMs: 150,
        onStdoutChunk: (chunk) => { childPid = Number(/\d+/.exec(chunk.toString())?.[0] ?? 0); },
      },
    ))).rejects.toMatchObject({ reason: "timeout" });
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("kills and reaps an aborted child before rejecting", async () => {
    const controller = new AbortController();
    let childPid = 0;
    const running = runBoundedProcess(processOptions(
      "console.log(process.pid); setInterval(() => {}, 1000)",
      {
        signal: controller.signal,
        onStdoutChunk: (chunk) => {
          childPid = Number(/\d+/.exec(chunk.toString())?.[0] ?? 0);
          controller.abort();
        },
      },
    ));
    await expect(running).rejects.toMatchObject({ reason: "aborted" });
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("kills on a streaming protocol callback failure without exposing its detail", async () => {
    const failure = runBoundedProcess(processOptions('process.stdout.write("provider-secret")', {
      onStdoutChunk: () => { throw new Error("provider-secret"); },
    }));
    await expect(failure).rejects.toEqual(expect.objectContaining({
      reason: "protocol_invalid",
      message: "bounded child process failed closed (protocol_invalid)",
    }));
    await failure.catch((error: unknown) => {
      expect(String(error)).not.toContain("provider-secret");
    });
  });

  it("rejects oversized stdin and spawn failure with typed, non-retry-safe outcomes", async () => {
    await expect(runBoundedProcess(processOptions("", { input: "xx", maxInputBytes: 1 })))
      .rejects.toMatchObject({ reason: "stdin_limit", retrySafe: false });
    await expect(runBoundedProcess({
      ...processOptions(""),
      command: `/definitely-missing-jarvis-process-${process.pid}`,
    })).rejects.toBeInstanceOf(BoundedProcessError);
  });

  it("routes all four agent-runner process boundaries through the bounded layer", () => {
    const source = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    expect(source.match(/runBoundedProcess\(\{/g)).toHaveLength(4);
    expect(source).toContain("new BoundedAgentRunnerDecoder()");
    expect(source).toContain("DEFAULT_GIT_PROCESS_TIMEOUT_MS = 2 * 60_000");
    expect(source).not.toContain("24 * 60 * 60_000");
    expect(source).not.toMatch(/\bbuf\s*\+=/);
    expect(source).not.toContain("JSON.parse(line)");
  });
});
