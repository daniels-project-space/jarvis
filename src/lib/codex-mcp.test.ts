import { describe, expect, it } from "vitest";
import { codexMcpConfigArgs, disabledCodexMcpHandoff } from "./codex-mcp";

describe("Codex MCP CLI configuration", () => {
  it("never builds stdio child configuration, even for a credentialed request", () => {
    const args = codexMcpConfigArgs({
      mcpServers: {
        browserbase: {
          command: "npx",
          args: ["-y", "@browserbasehq/mcp-server-browserbase"],
          envVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
        },
      },
    });
    expect(args).toEqual([]);
  });

  it("turns Context7 and Playwright into a controller handoff without config, process env, or subscription token", () => {
    const handoff = disabledCodexMcpHandoff(["context7", "playwright", "context7"]);
    expect(handoff.configPath).toBeNull();
    expect(handoff.env).toEqual({});
    expect(handoff.unavailable).toEqual([
      "context7 (stdio MCP disabled pending the controller proxy)",
      "playwright (stdio MCP disabled pending the controller proxy)",
    ]);
    expect(JSON.stringify(handoff)).not.toMatch(/mcp_servers|CODEX_ACCESS_TOKEN|@upstash|npx/);
  });
});
