import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const triggerDir = join(process.cwd(), "src/trigger");
const productionSources = new Map(
  readdirSync(triggerDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => [name, readFileSync(join(triggerDir, name), "utf8")]),
);

describe("source-level Codex process boundary", () => {
  it("routes foreground, restricted review, and specialist processes through the sole launcher", () => {
    const modelProcessFiles = [
      "agent-runner.ts",
      "chat-session.ts",
      "codex-app-server.ts",
      "codex-review.ts",
      "specialist-sandbox-smoke.ts",
    ];
    for (const name of modelProcessFiles) {
      const source = productionSources.get(name) ?? "";
      expect(source, name).toContain('from "./codex-launcher"');
      expect(source, name).toContain("spawnCodex");
    }
    const resolverConsumers = [...productionSources]
      .filter(([, source]) => source.includes("resolveSubscriptionAgentBin"))
      .map(([name]) => name)
      .sort();
    expect(resolverConsumers).toEqual([
      "agent-runner.ts",
      "chat-session.ts",
      "specialist-sandbox-smoke.ts",
      "subscription-runtime.ts",
    ]);
    for (const [name, source] of productionSources) {
      if (name === "codex-launcher.ts") continue;
      expect(source, name).not.toMatch(/\bspawn(?:Sync)?\(\s*(?:codex|bin|this\.bin)\b/);
      expect(source, name).not.toMatch(/\bexecFile(?:Sync)?\(\s*(?:codex|bin|this\.bin)\b/);
    }
  });

  it("contains no dangerous model flags, stdio MCP child config, metered key value, or auth-file write", () => {
    const all = [...productionSources.values()].join("\n");
    const modelConfiguration = [...productionSources]
      .filter(([name]) => name !== "codex-launcher.ts")
      .map(([, source]) => source)
      .join("\n");
    expect(modelConfiguration).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(modelConfiguration).not.toContain('"danger-full-access"');
    expect(all).not.toMatch(/mcp_servers\.|@upstash\/context7-mcp|mcp-server-playwright/);
    expect(all).not.toMatch(/writeFileSync\([^\n]*auth\.json/);
    expect(all).not.toMatch(/(?:OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*["'][^"']+["']/);
    expect(productionSources.get("model-policy.ts")).toContain('shell_environment_policy.inherit="none"');
    expect(productionSources.get("codex-launcher.ts")).toContain("assertCredentiallessHome");
  });
});
