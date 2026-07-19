export type CodexMcpServerConfig = {
  command: string;
  args?: string[];
  envVars?: string[];
};

export type CodexMcpConfig = {
  mcpServers?: Record<string, CodexMcpServerConfig>;
};

/**
 * Codex CLI parses every --config value as TOML. JSON string/array literals are
 * valid TOML values, but JSON objects are not TOML inline tables. Secrets stay
 * in the child process environment and only their variable names are passed.
 */
export function codexMcpConfigArgs(config: CodexMcpConfig): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !server?.command) continue;
    args.push("--config", `mcp_servers.${name}.command=${JSON.stringify(server.command)}`);
    if (server.args?.length) args.push("--config", `mcp_servers.${name}.args=${JSON.stringify(server.args)}`);
    if (server.envVars?.length) {
      const names = [...new Set(server.envVars.filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)))];
      if (names.length) args.push("--config", `mcp_servers.${name}.env_vars=${JSON.stringify(names)}`);
    }
  }
  return args;
}
