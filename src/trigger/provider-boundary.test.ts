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

  it("removes direct Groq and Google Maps/Places billing paths", () => {
    const root = join(process.cwd(), "src");
    const violations = runtimeFiles(root)
      .filter((path) => /api\.groq\.com|GROQ_API_KEY|places\.googleapis\.com|maps\.googleapis\.com|GOOGLE_PLACES_API_KEY/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path));
    expect(violations).toEqual([]);
    const stt = join(root, "app/api/stt/route.ts");
    expect(readFileSync(stt, "utf8")).toContain("/audio/transcriptions");
    expect(readFileSync(stt, "utf8")).toContain("LOCAL_STT_URL");
    expect(readFileSync(stt, "utf8")).toContain("local-faster-whisper");
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
