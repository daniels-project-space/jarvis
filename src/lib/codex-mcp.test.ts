import { describe, expect, it } from "vitest";
import { codexMcpConfigArgs } from "./codex-mcp";

describe("Codex MCP CLI configuration", () => {
  it("forwards secret names through TOML env_vars without putting values in argv", () => {
    const args = codexMcpConfigArgs({
      mcpServers: {
        browserbase: {
          command: "npx",
          args: ["-y", "@browserbasehq/mcp-server-browserbase"],
          envVars: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
        },
      },
    });
    expect(args).toContain('mcp_servers.browserbase.env_vars=["BROWSERBASE_API_KEY","BROWSERBASE_PROJECT_ID"]');
    expect(args.join(" ")).not.toContain("bb_live_");
    expect(args.join(" ")).not.toContain("mcp_servers.browserbase.env=");
  });
});
