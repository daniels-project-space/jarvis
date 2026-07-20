import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSubscriptionCredentialFresh,
  isolateSubscriptionEnv,
  missingSubscriptionTools,
  prepareSubscriptionEnv,
  REQUIRED_AGENT_TOOLS,
  resolveSubscriptionAgentBin,
} from "./subscription-runtime";

function jwt(expMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url");
  return `${header}.${payload}.synthetic`;
}

function authEnvelope(accessToken: string): string {
  return Buffer.from(JSON.stringify({
    tokens: {
      access_token: accessToken,
      refresh_token: "synthetic-refresh-never-write",
    },
  })).toString("base64");
}

function allFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

describe("subscription subprocess capability scope", () => {
  it("extracts only the expiring access token in memory and never materializes auth JSON", () => {
    const now = 2_000_000_000_000;
    const root = mkdtempSync(join(tmpdir(), "jarvis-codex-auth-test-"));
    const accessToken = jwt(now + 60 * 60_000);
    try {
      const prepared = prepareSubscriptionEnv("codex", {
        boundedRuntimeMs: 25 * 60_000,
        nowMs: now,
        runtimeRoot: root,
        scope: "worker",
        sourceEnv: {
          PATH: process.env.PATH,
          CODEX_AUTH_JSON_B64: authEnvelope(accessToken),
          JARVIS_DISPATCH_TOKEN: "synthetic-dispatch",
          JARVIS_WORKER_TOKEN: "synthetic-worker",
          GITHUB_TOKEN: "synthetic-github",
          VAULT_ACCESS_TOKEN: "synthetic-vault",
        },
      });
      expect(prepared.error).toBeUndefined();
      expect(prepared.env.CODEX_ACCESS_TOKEN).toBe(accessToken);
      expect(prepared.env.CODEX_AUTH_JSON_B64).toBeUndefined();
      expect(prepared.env.JARVIS_DISPATCH_TOKEN).toBeUndefined();
      expect(prepared.env.JARVIS_WORKER_TOKEN).toBeUndefined();
      expect(prepared.env.GITHUB_TOKEN).toBeUndefined();
      expect(prepared.env.VAULT_ACCESS_TOKEN).toBeUndefined();
      expect(existsSync(join(String(prepared.env.CODEX_HOME), "auth.json"))).toBe(false);
      const disk = allFiles(root).map((path) => readFileSync(path, "utf8")).join("\n");
      expect(disk).not.toContain(accessToken);
      expect(disk).not.toContain("synthetic-refresh-never-write");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed with an explicit refresh status when JWT life cannot cover the segment plus margin", () => {
    const now = 2_000_000_000_000;
    const root = mkdtempSync(join(tmpdir(), "jarvis-codex-expiry-test-"));
    try {
      const prepared = prepareSubscriptionEnv("codex", {
        boundedRuntimeMs: 15 * 60_000,
        nowMs: now,
        runtimeRoot: root,
        sourceEnv: {
          PATH: process.env.PATH,
          CODEX_AUTH_JSON_B64: authEnvelope(jwt(now + 19 * 60_000)),
        },
      });
      expect(prepared.status).toBe("credential_refresh_required");
      expect(prepared.error).toContain("refresh required");
      expect(() => assertSubscriptionCredentialFresh(prepared.env, 15 * 60_000, now))
        .toThrow("refresh required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects raw auth JSON instead of copying its refresh credential", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-codex-raw-auth-test-"));
    try {
      const prepared = prepareSubscriptionEnv("codex", {
        runtimeRoot: root,
        sourceEnv: { PATH: process.env.PATH, CODEX_AUTH_JSON: '{"tokens":{}}' },
      });
      expect(prepared.error).toContain("raw Codex auth JSON is forbidden");
      expect(allFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives concurrent agents separate credentialless homes with only the scoped briefing", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-codex-home-test-"));
    const source = join(root, "source");
    const homes = join(root, "homes");
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "auth.json"), "synthetic stale credential");
      writeFileSync(join(source, "AGENTS.md"), "scoped briefing");
      const one = isolateSubscriptionEnv({ CODEX_HOME: source }, "job-one", homes);
      const two = isolateSubscriptionEnv({ CODEX_HOME: source }, "job-two", homes);
      expect(one.CODEX_HOME).not.toBe(two.CODEX_HOME);
      expect(readFileSync(join(String(one.CODEX_HOME), "AGENTS.md"), "utf8")).toBe("scoped briefing");
      expect(existsSync(join(String(one.CODEX_HOME), "auth.json"))).toBe(false);
      expect(existsSync(join(String(two.CODEX_HOME), "auth.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the pinned runtime and every required specialist executable", () => {
    expect(resolveSubscriptionAgentBin("codex")).toMatch(/codex/);
    expect(missingSubscriptionTools(process.env, REQUIRED_AGENT_TOOLS)).toEqual([]);
    expect(missingSubscriptionTools({ PATH: "/definitely/missing" }, ["curl", "git"]))
      .toEqual(["curl", "git"]);
  });
});
