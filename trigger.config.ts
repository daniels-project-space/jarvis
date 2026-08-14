import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, ffmpeg, syncEnvVars } from "@trigger.dev/build/extensions/core";

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
    external: ["@openai/codex", "@napi-rs/canvas", "e2b", "sandbox0", "@vercel/sandbox", "web-push"],
    extensions: [
      additionalPackages({ packages: [
        "@openai/codex@0.144.5",
        "@napi-rs/canvas@0.1.80",
        "e2b@2.35.0",
        "sandbox0@0.9.3",
        "@vercel/sandbox@3.0.0",
      ] }),
      // Git and archive utilities are controller-only. The pinned protocol's
      // live permission attestation disables built-in host tools, so cloud
      // repository commands cross only the provider adapter.
      aptGet({ packages: ["curl", "git", "gh", "jq", "ca-certificates"] }),
      syncEnvVars(() => {
        const values = Object.fromEntries(
          [
            // Managed ChatGPT state is fetched by the controller from the
            // codex-session vault service and persisted encrypted in its
            // private R2 bucket. Never fan auth.json into Trigger containers.
            "CONVEX_URL", "JARVIS_WORKER_TOKEN", "JARVIS_DISPATCH_TOKEN", "GITHUB_TOKEN", "VAULT_ACCESS_TOKEN",
            // Trigger refreshes only explicit saved-trip Gmail identities. It
            // needs the same server-side OAuth envelope inputs as Vercel; no
            // OAuth bearer is ever synced or written into a task payload.
            "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY",
            // Dedicated, read-only Hub context capability. It stays in the
            // trusted worker/controller environment and is stripped from any
            // Codex child process before spawn.
            "JARVIS_HUB_CONTEXT_TOKEN",
            // Separate, narrowly scoped Hub to-do/widget actions capability.
            // This is never made available to browser code or Codex children.
            "JARVIS_HUB_ACTIONS_TOKEN",
            "JARVIS_PRIVATE_R2_BUCKET",
            "JARVIS_CODEX_SESSION_SOURCE",
            "JARVIS_MISSION_PROTOCOL_ROLLOUT",
            "JARVIS_MISSION_SUPERVISOR_ROLLOUT",
            // Exact non-secret origin allowlist for private media transcription.
            // The endpoint and bearer remain Vault-only.
            "JARVIS_LOCAL_STT_ORIGIN",
            // Non-secret immutable identity for the optional, bounded Novita
            // patch proposer. The API key stays behind VAULT_ACCESS_TOKEN.
            "JARVIS_NOVITA_QWEN_ATTESTATION",
            "JARVIS_CLOUD_WORKSPACE_PROVIDER", "JARVIS_CLOUD_WORKSPACE_TEMPLATE", "JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST", "JARVIS_VERCEL_PRO_SPEND_APPROVED",
            "JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID", "JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT", "JARVIS_CLOUD_PROVIDER_PROBE_KEYRING",
            "E2B_API_KEY", "SANDBOX0_TOKEN", "SANDBOX0_BASE_URL", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID",
          ]
            .map((key) => [key, process.env[key]])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        return Object.keys(values).length ? values : undefined;
      }),
      // Installs ffmpeg and ffprobe and pins their deployed paths in
      // FFMPEG_PATH/FFPROBE_PATH for bounded private video frame extraction.
      ffmpeg(),
    ],
  },
});
