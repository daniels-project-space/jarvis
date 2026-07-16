import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

// jarvis-jobs — runs the selected Codex/Claude subscription CLI headlessly;
// metered API keys are blanked inside agent subprocesses.
// Set TRIGGER_PROJECT_REF_JARVIS once the `jarvis-jobs` project is created in
// the Trigger.dev dashboard, then `npx trigger.dev deploy`.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF_JARVIS ?? "proj_wjwbdgeipgpddvrazxnp",
  runtime: "node",
  logLevel: "log",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  build: {
    // Subscription CLIs read their bundled Linux binary from disk. Pin exact
    // versions so a new upstream release cannot silently change a live runner.
    external: ["@anthropic-ai/claude-code", "@openai/codex", "web-push"],
    extensions: [
      additionalPackages({ packages: ["@anthropic-ai/claude-code@2.1.211", "@openai/codex@0.144.5"] }),
      aptGet({ packages: ["git", "ca-certificates"] }),
      syncEnvVars(() => {
        const value = process.env.CODEX_AUTH_JSON_B64;
        return value ? { CODEX_AUTH_JSON_B64: value } : undefined;
      }),
    ],
  },
});
