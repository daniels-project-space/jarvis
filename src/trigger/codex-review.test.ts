import { EventEmitter } from "node:events";
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewPrompt, type CodexReviewSpawn } from "./codex-review";

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

const temporaryRoots: string[] = [];

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controller Codex review transport", () => {
  it("streams a payload over 200 KiB intact through dash stdin without argv or a temporary file", async () => {
    const prompt = `signed-review-receipt\n${"diff-line-0123456789abcdef\n".repeat(8_500)}receipt-end`;
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(200 * 1024);

    const tempRoot = mkdtempSync(join(tmpdir(), "jarvis-review-transport-"));
    temporaryRoots.push(tempRoot);
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      CODEX_ACCESS_TOKEN: "subscription-test-token",
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
      TMPDIR: tempRoot,
    };

    let invocation: {
      command: string;
      args: readonly string[];
      options: Parameters<CodexReviewSpawn>[2];
    } | undefined;
    const spawnReview: CodexReviewSpawn = (command, args, options) => {
      invocation = { command, args: [...args], options };
      return spawnChild(
        process.execPath,
        [
          "-e",
          "const chunks=[];process.stdin.on('data',(chunk)=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)));",
        ],
        {
          env: { ...process.env, OPENAI_API_KEY: "", CODEX_API_KEY: "", TMPDIR: tempRoot },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    };
    const bin = "/opt/pinned/@openai/codex/0.144.5/bin/codex";

    await expect(reviewPrompt(bin, env, prompt, 90_000, spawnReview)).resolves.toBe(prompt);

    expect(invocation).toEqual({
      command: bin,
      args: [
        "exec",
        "--model",
        "gpt-5.6-terra",
        "--config",
        'model_reasoning_effort="medium"',
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--strict-config",
        "--config",
        'approval_policy="never"',
        "--config",
        'web_search="disabled"',
        "--config",
        'shell_environment_policy.inherit="none"',
        "--config",
        "project_doc_max_bytes=0",
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "apps",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--disable",
        "multi_agent",
        "-",
      ],
      options: {
        cwd: "/app",
        env,
        stdio: ["pipe", "pipe", "pipe"],
        boundedRuntimeMs: 90_000,
      },
    });
    expect(invocation!.args.join("\0")).not.toContain("signed-review-receipt");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("settles an asynchronous spawn error exactly once without hanging", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnReview: CodexReviewSpawn = () => child;
    let settlements = 0;
    const result = reviewPrompt("/missing/codex", { NODE_ENV: "test" }, "receipt", 90_000, spawnReview);
    void result.then(() => { settlements += 1; });

    child.emit("error", new Error("spawn ENOENT"));
    await expect(result).resolves.toBe("");
    child.emit("close", -1, null);
    await vi.runAllTimersAsync();

    expect(settlements).toBe(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills a timed-out reviewer and ignores later terminal events", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    child.kill.mockImplementation(() => { throw new Error("process already gone"); });
    const spawnReview: CodexReviewSpawn = () => child;
    let settlements = 0;
    const result = reviewPrompt("/pinned/codex", { NODE_ENV: "test" }, "receipt", 90_000, spawnReview);
    void result.then(() => { settlements += 1; });
    child.stdout.write("partial-review");

    await vi.advanceTimersByTimeAsync(89_999);
    expect(settlements).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("partial-review");

    child.emit("error", new Error("late error"));
    child.emit("close", null, "SIGKILL");
    await vi.runAllTimersAsync();
    expect(settlements).toBe(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
