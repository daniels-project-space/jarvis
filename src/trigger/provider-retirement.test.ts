import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeWorkspaceCheckpoint } from "../lib/workspace-checkpoint";
import { configuredCloudWorkspaceCleanupProvider } from "./cloud-workspace-providers";

describe("Daytona retirement", () => {
  it("removes the executable dependency, adapter, selector, bundle, and credential sync", () => {
    const packageJson = source("package.json");
    const lock = source("package-lock.json");
    const provider = source("src/trigger/cloud-workspace-providers.ts");
    const trigger = source("trigger.config.ts");
    expect(packageJson).not.toContain("@daytona/sdk");
    expect(lock).not.toContain("node_modules/@daytona/sdk");
    expect(provider).not.toContain("DaytonaCloudWorkspaceProvider");
    expect(provider).not.toContain('import("@daytona/sdk")');
    expect(trigger).not.toMatch(/DAYTONA|@daytona/);
  });

  it("preserves historical checkpoint identity but blocks orphan cleanup without fallback", () => {
    const checkpoint = normalizeWorkspaceCheckpoint({
      version: 2, jobId: "historical", attempt: 1, provider: "daytona",
      providerWorkspaceId: "workspace", providerSessionId: "session", baseSha: "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64), sourceArchiveBytes: 1, archiveSha256: "c".repeat(64),
      archiveBytes: 1, runtime: "node-22", lockfileDigest: "d".repeat(64), template: "legacy",
      attemptKey: "historical:1", causationId: "legacy-run", createdAt: 1,
    });
    expect(checkpoint.provider).toBe("daytona");
    expect(() => configuredCloudWorkspaceCleanupProvider({ E2B_API_KEY: "fallback-must-not-run" }, "daytona"))
      .toThrow(expect.objectContaining({ provider: "daytona", code: "cleanup_blocked" }));
  });
});

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
