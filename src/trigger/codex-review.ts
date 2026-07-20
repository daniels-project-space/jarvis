import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CODEX_REVIEW_WORKING_DIRECTORY,
  codexReviewExecPrefix,
} from "./model-policy";

type ReviewSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
};

export type CodexReviewSpawn = (
  command: string,
  args: readonly string[],
  options: ReviewSpawnOptions,
) => ChildProcessWithoutNullStreams;

const spawnCodexReview: CodexReviewSpawn = (command, args, options) =>
  spawn(command, args, options);

// Controller receipts can exceed Linux's single-argument limit. Codex exec's
// dash prompt contract keeps the signed payload out of argv and streams it
// directly from memory, without introducing a mutable temporary-file handoff.
export function reviewPrompt(
  bin: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  timeoutMs: number,
  spawnReview: CodexReviewSpawn = spawnCodexReview,
): Promise<string> {
  return new Promise((resolve) => {
    const args = [...codexReviewExecPrefix("terra"), "-"];
    let child: ChildProcessWithoutNullStreams | undefined;
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: string, terminate = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (terminate && child) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      resolve(value);
    };

    try {
      child = spawnReview(bin, args, {
        cwd: CODEX_REVIEW_WORKING_DIRECTORY,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish("");
      return;
    }

    child.stdout.on("data", (data) => (output += data.toString()));
    child.stdout.once("error", () => finish("", true));
    child.stderr.once("error", () => finish("", true));
    child.stderr.resume();
    child.stdin.once("error", () => finish("", true));
    child.once("close", () => finish(output));
    child.once("error", () => finish("", true));

    timer = setTimeout(() => finish(output, true), timeoutMs);
    try {
      child.stdin.end(prompt, "utf8");
    } catch {
      finish("", true);
    }
  });
}
