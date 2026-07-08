import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalPackages, aptGet } from "@trigger.dev/build/extensions/core";

// jarvis-jobs — runs Claude Code HEADLESS on Daniel's Max subscription
// (CLAUDE_CODE_OAUTH_TOKEN pulled from the project-hub vault at runtime;
// ANTHROPIC_API_KEY blanked → never the metered API). Mirrors remote-work-hub.
// Set TRIGGER_PROJECT_REF_JARVIS once the `jarvis-jobs` project is created in
// the Trigger.dev dashboard, then `npx trigger.dev deploy`.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF_JARVIS ?? "proj_PENDING_jarvis_jobs",
  runtime: "node",
  logLevel: "log",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  build: {
    // Claude Code reads its bundled binary from disk — keep it out of the
    // esbuild bundle; Trigger installs it fresh (correct Linux binary).
    external: ["@anthropic-ai/claude-code"],
    extensions: [
      additionalPackages({ packages: ["@anthropic-ai/claude-code@latest"] }),
      aptGet({ packages: ["git", "ca-certificates"] }),
    ],
  },
});
