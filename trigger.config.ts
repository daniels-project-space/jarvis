import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet, ffmpeg, syncEnvVars } from "@trigger.dev/build/extensions/core";
import { syncedJarvisTriggerEnvironment } from "./src/trigger/trigger-env";

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
      syncEnvVars(() => syncedJarvisTriggerEnvironment(process.env)),
      // Installs ffmpeg and ffprobe and pins their deployed paths in
      // FFMPEG_PATH/FFPROBE_PATH for bounded private video frame extraction.
      ffmpeg(),
    ],
  },
});
