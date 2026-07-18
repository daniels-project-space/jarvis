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

  it("ships no legacy provider credential in the Codex agent workflow", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/jarvis-agent-harness.yml"), "utf8");
    expect(workflow).not.toMatch(/CLAUDE|ANTHROPIC/i);
    expect(workflow).toContain("CODEX_AUTH_JSON_B64");
  });
});
