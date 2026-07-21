import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVEX_PREMERGE_PROOF_COMMAND,
  convexPremergeReceiptProvesNoMutation,
  convexReleaseAction,
  createProviderToolSession,
  generatedTriggerAttestor,
  installDependenciesInPinnedCheckout,
  triggerDeployCommand,
  triggerPromoteCommand,
  triggerReleaseEnv,
} from "./provider-release-runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider release pinned dependency install", () => {
  it("runs npm ci only between two exact source and cleanliness checks", async () => {
    const events: string[] = [];
    const verifyPinned = vi.fn(async (sha: string) => {
      events.push(`verify:${sha}`);
      return "/tmp/exact-checkout";
    });
    const runNpmCi = vi.fn(async (cwd: string) => { events.push(`npm-ci:${cwd}`); });
    const sha = "a".repeat(40);

    await expect(installDependenciesInPinnedCheckout({ sourceSha: sha, verifyPinned, runNpmCi }))
      .resolves.toBe("/tmp/exact-checkout");
    expect(events).toEqual([
      `verify:${sha}`,
      "npm-ci:/tmp/exact-checkout",
      `verify:${sha}`,
    ]);
  });

  it("fails closed when dependency installation changes checkout identity", async () => {
    const verifyPinned = vi.fn()
      .mockResolvedValueOnce("/tmp/exact-checkout")
      .mockResolvedValueOnce("/tmp/replaced-checkout");
    await expect(installDependenciesInPinnedCheckout({
      sourceSha: "b".repeat(40),
      verifyPinned,
      runNpmCi: async () => undefined,
    })).rejects.toThrow("changed the pinned checkout identity");
  });
});

describe("cross-project provider command isolation", () => {
  const dropshipProject = "proj_ebwgqvfufapbqnhjxhnc";
  const dropshipConfig = `import { defineConfig } from "@trigger.dev/sdk/v3";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_ebwgqvfufapbqnhjxhnc",
  dirs: ["./src/trigger"],
  maxDuration: 600,
  build: { extensions: [syncEnvVars(() => process.env.VAULT_ACCESS_TOKEN
    ? { VAULT_ACCESS_TOKEN: process.env.VAULT_ACCESS_TOKEN }
    : undefined)] },
});
`;
  const dropshipTasks = ["approval-gate.ts", "content-factory.ts", "fulfillment.ts", "signal-ingest.ts"];

  it("uses target-only Trigger authority, an explicit project, and never syncs target env", () => {
    const base: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: "/usr/bin",
      HOME: "/tmp",
      VAULT_ACCESS_TOKEN: "jarvis-vault",
      JARVIS_WORKER_TOKEN: "jarvis-worker",
      JARVIS_DISPATCH_TOKEN: "jarvis-dispatch",
      CODEX_AUTH_JSON_B64: "jarvis-codex-auth",
      CODEX_ACCESS_TOKEN: "jarvis-codex-token",
      GITHUB_TOKEN: "jarvis-github",
      CONVEX_URL: "https://jarvis.convex.cloud",
      NEXT_PUBLIC_CONVEX_URL: "https://jarvis.convex.cloud",
      CONVEX_DEPLOY_KEY_JARVIS_CANONICAL: "jarvis-convex",
      TRIGGER_ACCESS_TOKEN_JARVIS: "jarvis-trigger",
      NODE_OPTIONS: "--require=/tmp/jarvis-hook.cjs",
      NPM_CONFIG_REGISTRY: "https://registry.example/?token=jarvis",
    };
    const session = createProviderToolSession(base);
    try {
      const env = triggerReleaseEnv(base, "dropship-target-access-token", session);
      expect(env.TRIGGER_ACCESS_TOKEN).toBe("dropship-target-access-token");
      expect(env.HOME).toBe(session.home);
      expect(env.HOME).not.toBe(base.HOME);
      for (const key of [
        "VAULT_ACCESS_TOKEN", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN",
        "CODEX_AUTH_JSON_B64", "CODEX_ACCESS_TOKEN", "GITHUB_TOKEN", "CONVEX_URL",
        "NEXT_PUBLIC_CONVEX_URL", "CONVEX_DEPLOY_KEY_JARVIS_CANONICAL",
        "TRIGGER_ACCESS_TOKEN_JARVIS", "NODE_OPTIONS", "NPM_CONFIG_REGISTRY",
      ]) expect(env[key], key).toBeUndefined();

      expect(triggerDeployCommand(dropshipProject)).toEqual([
        "--no-install", "trigger.dev", "deploy", "--project-ref", dropshipProject,
        "--env-file", "/dev/null", "--skip-promotion", "--skip-sync-env-vars",
      ]);
      expect(triggerPromoteCommand(dropshipProject, "20260720.42"))
        .toEqual(["--no-install", "trigger.dev", "promote", "20260720.42", "--project-ref", dropshipProject]);
      expect(dropshipConfig).toContain("syncEnvVars");
      expect(env.VAULT_ACCESS_TOKEN).toBeUndefined();
    } finally {
      session.cleanup();
    }
  });

  it("injects a collision-resistant target-native task into Dropship's actual task directory shape", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-dropship-trigger-fixture-"));
    roots.push(root);
    const taskDir = join(root, "src/trigger");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(root, "trigger.config.ts"), dropshipConfig);
    for (const task of dropshipTasks) writeFileSync(join(taskDir, task), `export const fixture = ${JSON.stringify(task)};\n`);

    const releaseId = `providers-v2:${"b".repeat(64)}`;
    const attestor = generatedTriggerAttestor({
      releaseId,
      sourceSha: "a".repeat(40),
      projectRef: dropshipProject,
    });
    const second = generatedTriggerAttestor({
      releaseId,
      sourceSha: "c".repeat(40),
      projectRef: dropshipProject,
    });
    expect(attestor.taskId).not.toBe(second.taskId);
    expect(attestor.relativePath).toMatch(/^src\/trigger\/__provider_release_attestor_[0-9a-f]{20}\.ts$/);
    expect(dropshipTasks).not.toContain(attestor.relativePath.split("/").at(-1));
    writeFileSync(join(root, attestor.relativePath), attestor.source);
    const source = readFileSync(join(root, attestor.relativePath), "utf8");
    expect(source).toContain(`"releaseId":"${releaseId}"`);
    expect(source).toContain(`"sourceSha":"${"a".repeat(40)}"`);
    expect(source).toContain(`"projectRef":"${dropshipProject}"`);
    expect(source).toContain(`"taskId":"${attestor.taskId}"`);
    expect(source).not.toMatch(/jarvis|\.\.\/lib|specialist-sandbox|process\.env/i);
  });

  it("keeps every premerge Convex proof local and reserves deploy for postmerge", () => {
    expect(convexReleaseAction("premerge")).toBe("local-proof");
    expect(convexReleaseAction("postmerge")).toBe("live-deploy");
    expect(CONVEX_PREMERGE_PROOF_COMMAND).toEqual([
      "--no-install", "convex", "deploy", "--dry-run", "--typecheck", "enable",
      "--codegen", "disable", "--env-file", "/dev/null",
    ]);
    const exact = {
      code: 0,
      out: "Would have deployed Convex functions to https://target.convex.cloud",
      receipt: {
        protocol: 1 as const,
        candidateSandbox: true as const,
        executable: "npx" as const,
        argv: CONVEX_PREMERGE_PROOF_COMMAND,
        commandDigest: "a".repeat(64),
        startedAt: 10,
        closedAt: 20,
        closeObserved: true as const,
        timedOut: false,
        capability: "CONVEX_DEPLOY_KEY" as const,
      },
    };
    expect(convexPremergeReceiptProvesNoMutation(exact)).toBe(true);
    expect(convexPremergeReceiptProvesNoMutation({
      ...exact,
      receipt: { ...exact.receipt, argv: [...CONVEX_PREMERGE_PROOF_COMMAND, "--yes"] },
    })).toBe(false);
    const runtimeSource = readFileSync(join(process.cwd(), "src/trigger/provider-release-runtime.ts"), "utf8");
    expect(runtimeSource).toContain('if (step.phase !== "postmerge") throw new Error("live Convex deployment is forbidden before merge")');
    expect(runtimeSource).not.toContain("const [accessToken, secretKey] = await Promise.all");
    expect(runtimeSource.indexOf("this.candidateOutput(result, `Trigger ${trigger.projectRef} staged deploy`)")).toBeLessThan(
      runtimeSource.indexOf("const secretKey = await this.capability(trigger.secretKey)"),
    );
  });

  it("rejects credential-bearing proxy URLs from provider tools", () => {
    expect(() => createProviderToolSession({ NODE_ENV: "test", HTTPS_PROXY: "https://u:p@proxy.example" }))
      .toThrow(/credential-bearing/);
  });
});
