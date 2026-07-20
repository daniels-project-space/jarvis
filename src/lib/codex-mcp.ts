export type CodexMcpServerConfig = {
  command: string;
  args?: string[];
  envVars?: string[];
};

export type CodexMcpConfig = {
  mcpServers?: Record<string, CodexMcpServerConfig>;
};

export type DisabledCodexMcpHandoff = Readonly<{
  configPath: null;
  env: Readonly<Record<string, never>>;
  unavailable: string[];
}>;

export function disabledCodexMcpHandoff(names: readonly string[]): DisabledCodexMcpHandoff {
  const requested = [...new Set(names.map((name) => String(name).trim().toLowerCase()).filter(Boolean))];
  return {
    configPath: null,
    env: {},
    unavailable: requested.map((name) => `${name} (stdio MCP disabled pending the controller proxy)`),
  };
}

/**
 * Stdio MCPs share the model process tree and therefore cannot receive either
 * subscription or provider authority. Keep the old boundary as an explicit
 * fail-closed shim until a controller-hosted proxy replaces it.
 */
export function codexMcpConfigArgs(_config: CodexMcpConfig): string[] {
  return [];
}
