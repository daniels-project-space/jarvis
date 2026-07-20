import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { PROJECT_BY_SLUG } from "./src/lib/project-registry";

// Trigger hosts foreground conversation, the fleet controller and independent
// specialist containers. Every specialist remains a pinned Codex CLI process;
// metered API keys stay blanked inside the subscription subprocess.
const JARVIS_TRIGGER_PROJECT = PROJECT_BY_SLUG.get("jarvis")?.providerBoundary?.release?.trigger?.projectRef;
if (!JARVIS_TRIGGER_PROJECT) throw new Error("Jarvis's exact Trigger project is absent from the project registry");

export default defineConfig({
  // Provider routing is registry-owned. An ambient env value must never turn a
  // Jarvis release into a deployment for another Daniel-owned project.
  project: JARVIS_TRIGGER_PROJECT,
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
      // Bubblewrap creates a separate PID/mount namespace around every Codex
      // specialist. This is the credential boundary; child-env filtering alone
      // cannot stop a same-container process reading its parent through /proc.
      aptGet({ packages: ["curl", "git", "gh", "jq", "ca-certificates", "bubblewrap"] }),
      syncEnvVars(() => {
        const values = Object.fromEntries(
          ["CODEX_AUTH_JSON_B64", "CONVEX_URL", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN", "GITHUB_TOKEN", "VAULT_ACCESS_TOKEN", "JARVIS_RELEASE_SOURCE_SHA"]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        return Object.keys(values).length ? values : undefined;
      }),
    ],
  },
});
