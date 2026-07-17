/**
 * GitHub authentication belongs only to the runner's individual git process.
 * Supplying it through ephemeral Git config keeps credentials out of command
 * arguments and, critically, out of the cloned repository's remote URL.
 */
export function githubGitEnv(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export const githubRepoUrl = (repo: string): string => `https://github.com/${repo}.git`;
