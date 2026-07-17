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
    // A specialist owns the writable checkout and can therefore create a
    // .git/hooks/pre-push file. The credential is attached only after that
    // specialist exits, so every authenticated Git process must also override
    // hooks at command scope. GIT_CONFIG_* entries have the same precedence as
    // `git -c` and cannot be replaced by repository-local configuration.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
  };
}

export const githubRepoUrl = (repo: string): string => `https://github.com/${repo}.git`;
