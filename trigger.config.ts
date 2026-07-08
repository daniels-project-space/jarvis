import { defineConfig } from "@trigger.dev/sdk/v3";

// ⚠️ SETUP: the `jarvis-jobs` Trigger.dev project must be created in the Trigger.dev
// dashboard (the CLI cannot create projects — only login/init/deploy). Once created:
//   1. copy its project ref (proj_...) and a prod secret key,
//   2. store both in the project-hub vault under service `trigger`, scopes:["jarvis"]
//      (e.g. TRIGGER_PROJECT_REF_JARVIS, TRIGGER_SECRET_KEY_JARVIS),
//   3. set TRIGGER_PROJECT_REF_JARVIS in the environment and run `npx trigger.dev deploy`.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF_JARVIS ?? "proj_PENDING_jarvis_jobs",
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2, randomize: true },
  },
  dirs: ["./src/trigger"],
});
