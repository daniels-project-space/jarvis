import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureClaudeUserPrompt,
  createClaudePromptBinding,
  readClaudeLatestUserPrompt,
} from "./local-handover-claude-prompt-capture";

const directories: string[] = [];

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "jarvis-handover-prompt-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Claude prompt capture", () => {
  it("captures only an exact bound session and ignores the generated bootstrap prompt", async () => {
    const stateDir = await stateDirectory();
    const sessionId = "2f77b2cb-bb8d-4e1e-917b-4f1ef4c1b7ca";
    await createClaudePromptBinding({
      stateDir,
      managedSessionId: "my-work",
      sessionId,
      cwd: "/work/project",
      bootstrapPrompt: "Read the private handover bundle first.",
    });

    await expect(captureClaudeUserPrompt(stateDir, sessionId, {
      session_id: sessionId,
      cwd: "/work/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "Read the private handover bundle first.",
    })).resolves.toBe("ignored");
    await expect(captureClaudeUserPrompt(stateDir, sessionId, {
      session_id: sessionId,
      cwd: "/work/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "Please preserve the current edits. password=should-not-transfer",
    })).resolves.toBe("captured");
    await expect(captureClaudeUserPrompt(stateDir, sessionId, {
      session_id: "c75de6ae-81a9-465a-88ce-8a08d7536e3a",
      cwd: "/work/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "Wrong session.",
    })).resolves.toBe("ignored");

    await expect(readClaudeLatestUserPrompt(stateDir, sessionId)).resolves.toMatchObject({
      prompt: "Please preserve the current edits. password=[REDACTED]",
    });
  });
});
