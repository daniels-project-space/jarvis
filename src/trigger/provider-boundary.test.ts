import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function runtimeFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return runtimeFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("intelligence provider boundary", () => {
  it("pins Trigger workers to node-22 instead of the Node 21 default", () => {
    const config = readFileSync(join(process.cwd(), "trigger.config.ts"), "utf8");
    expect(config).toMatch(/^\s*runtime:\s*"node-22",\s*$/m);
  });

  it("keeps Groq limited to speech transcription transport", () => {
    const root = join(process.cwd(), "src");
    const stt = join(root, "app/api/stt/route.ts");
    const violations = runtimeFiles(root)
      .filter((path) => path !== stt)
      .filter((path) => /api\.groq\.com\/openai\/v1\/chat|llama-[\d.]|gpt-oss/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path));
    expect(violations).toEqual([]);
    expect(readFileSync(stt, "utf8")).toContain("/audio/transcriptions");
  });

  it("ships Trigger workers with the pinned Codex subscription boundary", () => {
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    const config = readFileSync(join(process.cwd(), "trigger.config.ts"), "utf8");
    const isolation = readFileSync(join(process.cwd(), "src/trigger/subscription-runtime.ts"), "utf8");
    expect(`${runner}\n${config}`).not.toMatch(/CLAUDE|ANTHROPIC/i);
    expect(config).toContain("@openai/codex@0.144.5");
    expect(runner).toContain('id: "jarvis-agent-worker"');
    expect(runner).toContain("afterUnauthorizedVersion: executionPrepared.snapshotVersion");
    expect(runner).not.toContain("afterUnauthorizedVersion: prepared.snapshotVersion");
    expect(isolation).toContain('env.OPENAI_API_KEY = ""');
    expect(isolation).not.toMatch(/VAULT_ACCESS_TOKEN.*allow/i);
  });
});
