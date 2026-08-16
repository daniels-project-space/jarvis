import { describe, expect, it } from "vitest";
import { codexMcpConfigArgs } from "./codex-mcp";

describe("Codex MCP CLI configuration", () => {
  it("forwards secret names through TOML env_vars without putting values in argv", () => {
    const args = codexMcpConfigArgs({
      mcpServers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          envVars: ["CONTEXT7_API_KEY", "CONTEXT7_PROJECT_ID"],
        },
      },
    });
    expect(args).toContain('mcp_servers.context7.env_vars=["CONTEXT7_API_KEY","CONTEXT7_PROJECT_ID"]');
    expect(args.join(" ")).not.toContain("ctx7_live_");
    expect(args.join(" ")).not.toContain("mcp_servers.context7.env=");
  });
});
