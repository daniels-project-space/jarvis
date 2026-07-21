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
    external: ["@openai/codex", "e2b", "sandbox0", "web-push"],
    extensions: [
      additionalPackages({ packages: [
        "@openai/codex@0.144.5",
        "e2b@2.35.0",
        "sandbox0@0.9.3",
      ] }),
      // Git and archive utilities are controller-only. The pinned protocol's
      // live permission attestation disables built-in host tools, so cloud
      // repository commands cross only the provider adapter.
      aptGet({ packages: ["curl", "git", "gh", "jq", "ca-certificates"] }),
      syncEnvVars(() => {
        const values = Object.fromEntries(
          [
            "CODEX_AUTH_JSON_B64", "CONVEX_URL", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN", "GITHUB_TOKEN", "VAULT_ACCESS_TOKEN",
            "JARVIS_CLOUD_WORKSPACE_PROVIDER", "JARVIS_CLOUD_WORKSPACE_TEMPLATE", "JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST",
            "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID", "JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT", "JARVIS_CLOUD_PROVIDER_PROBE_KEYRING",
            "E2B_API_KEY", "SANDBOX0_TOKEN", "SANDBOX0_BASE_URL",
          ]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        return Object.keys(values).length ? values : undefined;
      }),
    ],
  },
});
