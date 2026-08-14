import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const port = 4181;
const systemChromium = process.platform === "linux" && existsSync("/usr/bin/google-chrome")
  ? "/usr/bin/google-chrome"
  : undefined;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? systemChromium;
const chromiumArgs = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run",
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
];

export default defineConfig({
  fullyParallel: false,
  outputDir: "test-results/browser-startup",
  reporter: "list",
  retries: 0,
  testDir: "./e2e",
  testMatch: "startup-boot.real.spec.ts",
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: chromiumArgs,
    },
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: `npm run build && npx --no-install next start --hostname 127.0.0.1 --port ${port}`,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: false,
    timeout: 240_000,
    url: `http://127.0.0.1:${port}/`,
  },
  workers: 1,
});
