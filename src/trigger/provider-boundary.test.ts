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

  it("limits paid provider access to the explicit resilient STT fallback", () => {
    const root = join(process.cwd(), "src");
    const stt = join(root, "app/api/stt/route.ts");
    const violations = runtimeFiles(root)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        if (/places\.googleapis\.com|maps\.googleapis\.com|GOOGLE_PLACES_API_KEY/i.test(source)) return true;
        return path !== stt && /api\.groq\.com|GROQ_API_KEY/i.test(source);
      })
      .map((path) => relative(process.cwd(), path));
    expect(violations).toEqual([]);
    const sttSource = readFileSync(stt, "utf8");
    expect(sttSource).toContain("/audio/transcriptions");
    expect(sttSource).toContain("LOCAL_STT_URL");
    expect(sttSource).toContain("local-faster-whisper");
    expect(sttSource).toContain("whisper-large-v3-turbo");
    expect(sttSource.indexOf("config.local")).toBeLessThan(sttSource.indexOf("config.groqKey"));
    const tools = readFileSync(join(root, "lib/tools.ts"), "utf8");
    expect(tools).toContain("searchOpenStreetMapPlaces");
  });

  it("ships Trigger workers with the pinned Codex subscription boundary", () => {
    const runner = readFileSync(join(process.cwd(), "src/trigger/agent-runner.ts"), "utf8");
    const foreground = readFileSync(join(process.cwd(), "src/trigger/chat-session.ts"), "utf8");
    const config = readFileSync(join(process.cwd(), "trigger.config.ts"), "utf8");
    const isolation = readFileSync(join(process.cwd(), "src/trigger/subscription-runtime.ts"), "utf8");
    expect(`${runner}\n${config}`).not.toMatch(/CLAUDE|ANTHROPIC/i);
    expect(config).toContain("@openai/codex@0.144.5");
    expect(runner).toContain('id: "jarvis-agent-worker"');
    expect(runner).toContain("executionBoundary.boundary.snapshotVersion");
    expect(runner).toContain("CloudCodexPreStartAuthorizationError");
    expect(runner).not.toContain("isCodexUnauthorizedError(error)");
    expect(isolation).not.toContain('env.OPENAI_API_KEY = ""');
    expect(runner).toContain("queue: { name: BACKGROUND_QUEUE, concurrencyLimit: BACKGROUND_CONCURRENCY_LIMIT }");
    expect(foreground).toContain("queue: { name: FOREGROUND_QUEUE, concurrencyLimit: FOREGROUND_CONCURRENCY }");
    expect(isolation).not.toMatch(/VAULT_ACCESS_TOKEN.*allow/i);
  });
});
