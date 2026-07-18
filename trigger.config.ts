import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

// Trigger hosts foreground conversation and bounded maintenance schedules.
// Permanent specialist intelligence runs through the GitHub CLI harness;
// metered API keys remain blanked inside every subscription subprocess.
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
    external: ["@openai/codex", "web-push"],
    extensions: [
      additionalPackages({ packages: ["@openai/codex@0.144.5"] }),
      aptGet({ packages: ["git", "ca-certificates"] }),
      syncEnvVars(() => {
        const values = Object.fromEntries(
          ["CODEX_AUTH_JSON_B64", "CONVEX_URL", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN", "JARVIS_AGENT_RUNTIME", "VAULT_ACCESS_TOKEN"]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        return Object.keys(values).length ? values : undefined;
      }),
    ],
  },
});
