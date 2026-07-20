import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

// Trigger hosts foreground conversation, the fleet controller and independent
// specialist containers. Every specialist remains a pinned Codex CLI process;
// metered API keys stay blanked inside the subscription subprocess.
// Set TRIGGER_PROJECT_REF_JARVIS once the `jarvis-jobs` project is created in
// the Trigger.dev dashboard, then `npx trigger.dev deploy`.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF_JARVIS ?? "proj_wjwbdgeipgpddvrazxnp",
  runtime: "node-22",
  logLevel: "log",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  build: {
    // Subscription CLIs read their bundled Linux binary from disk. Pin exact
    // versions so a new upstream release cannot silently change a live runner.
    external: ["@openai/codex", "web-push"],
    extensions: [
      additionalPackages({ packages: ["@openai/codex@0.144.5"] }),
      // The Codex CLI receives a normal engineering shell in every isolated
      // worker. Credentials remain in the parent delivery controller.
      aptGet({ packages: ["curl", "git", "gh", "jq", "ca-certificates"] }),
      syncEnvVars(() => {
        const values = Object.fromEntries(
          ["CODEX_AUTH_JSON_B64", "CONVEX_URL", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN", "GITHUB_TOKEN", "VAULT_ACCESS_TOKEN"]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        return Object.keys(values).length ? values : undefined;
      }),
    ],
  },
});
