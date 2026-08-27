import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const port = 4179;
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
  outputDir: "test-results/trip-timeline",
  reporter: "list",
  retries: 0,
  testDir: "./e2e",
  testMatch: ["trip-timeline.fixture.spec.ts", "trip-location-follow.fixture.spec.ts", "trip-booked-stay-marker.fixture.spec.ts", "trip-city-itinerary-scope.fixture.spec.ts", "apple-maps-offline.fixture.spec.ts", "spoken-caption-layout.fixture.spec.ts", "artifact-card.fixture.spec.ts", "private-video-player.fixture.spec.ts", "private-pdf-viewer.fixture.spec.ts", "work-map-bubble.fixture.spec.ts"],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: chromiumArgs,
    },
    screenshot: "off",
    trace: "off",
    video: "off",
    viewport: { width: 960, height: 820 },
  },
  webServer: {
    command: "npx --no-install tsx e2e/fixtures/trip-timeline-server.ts",
    env: { PLAYWRIGHT_TRIP_FIXTURE_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 30_000,
    url: `http://127.0.0.1:${port}/`,
  },
  workers: 1,
});
