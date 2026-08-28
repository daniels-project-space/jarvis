import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  definition: undefined as { run: () => Promise<unknown> } | undefined,
  fetchPaths: [] as string[],
  gitCalls: [] as string[][],
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  schedules: {
    task: (definition: { run: () => Promise<unknown> }) => {
      harness.definition = definition;
      return definition;
    },
  },
}));

vi.mock("node:fs", () => ({
  existsSync: () => true,
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    harness.gitCalls.push([command, ...args]);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Simulate the dangerous path: writes were generated, but staging failed.
    queueMicrotask(() => child.emit("close", command === "git" && args.includes("add") ? 1 : 0));
    return child;
  }),
}));

vi.mock("./git-transport", () => ({
  githubGitEnv: (env: NodeJS.ProcessEnv) => env,
  githubRepoUrl: () => "https://example.test/jarvis-memory.git",
}));

vi.mock("./subscription-source", () => ({
  environmentWithoutSubscriptionController: (env: NodeJS.ProcessEnv) => ({ ...env }),
}));

vi.mock("../lib/memory-safety", () => ({
  redactSecrets: (value: unknown) => String(value ?? ""),
  safeMemoryNote: (title: unknown, body: unknown) => ({ title: String(title), body: String(body) }),
}));

import { memoryVault } from "./memory-vault";

beforeEach(() => {
  process.env.GITHUB_TOKEN = "delivery-test-token";
  process.env.JARVIS_WORKER_TOKEN = "delivery-test-worker";
  harness.fetchPaths.length = 0;
  harness.gitCalls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { path?: string };
    const path = request.path ?? "";
    harness.fetchPaths.push(path);
    const value = path === "memory:beginObsidianReconciliation"
      ? { cycle: 1, cutoffAt: 1 }
      : path === "memory:obsidianReconciliationPage"
        ? { items: [], isDone: true }
        : [];
    return { ok: true, json: async () => ({ status: "success", value }) };
  }));
});

afterEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.JARVIS_WORKER_TOKEN;
  vi.unstubAllGlobals();
});

describe("Obsidian memory-vault delivery checkpoint", () => {
  it("never advances the durable cursor when git staging fails", async () => {
    expect(memoryVault).toBeDefined();
    if (!harness.definition) throw new Error("memory-vault task was not registered");
    await expect(harness.definition.run()).rejects.toThrow("Obsidian mirror staging did not complete");
    expect(harness.gitCalls.some((args) => args.includes("diff"))).toBe(false);
    expect(harness.fetchPaths).toContain("memory:beginObsidianReconciliation");
    expect(harness.fetchPaths).toContain("memory:obsidianReconciliationPage");
    expect(harness.fetchPaths).not.toContain("memory:advanceObsidianReconciliation");
  });
});
