import { expect, test, type Locator, type Page } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4179";

function isSafeFixtureRequest(method: string, url: string) {
  try {
    const parsed = new URL(url);
    return (method === "GET" || method === "HEAD") && parsed.origin === fixtureOrigin;
  } catch {
    return false;
  }
}

async function fenceFixtureTraffic(page: Page) {
  const unsafeRequests: string[] = [];
  page.on("request", (request) => {
    if (!isSafeFixtureRequest(request.method(), request.url())) unsafeRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route("**/*", async (route) => {
    if (!isSafeFixtureRequest(route.request().method(), route.request().url())) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return unsafeRequests;
}

function rgbChannels(value: string) {
  const channels = value.match(/\d+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Expected an rgb colour, received ${value}`);
  return channels;
}

function colourDistance(left: number[], right: number[]) {
  return left.reduce((distance, channel, index) => distance + Math.abs(channel - right[index]), 0);
}

async function renderedColour(svg: Locator) {
  return rgbChannels(await svg.evaluate((node) => getComputedStyle(node).color));
}

test.describe("orb mood fixture", () => {
  test("uses the real conversation hook for completed replies, automatic priority, expiry, manual priority, and thread isolation", async ({ page }, testInfo) => {
    const unsafeRequests = await fenceFixtureTraffic(page);
    await page.setViewportSize({ width: 960, height: 820 });
    await page.goto("/orb-mood", { waitUntil: "networkidle" });

    const surface = page.getByRole("main", { name: "Jarvis orb mood fixture" });
    await expect(surface).toHaveAttribute("data-jarvis-mood", "calm");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "conversation");
    await expect(page.getByRole("img", { name: /jarvis visual core, calm mood/i })).toBeVisible();
    await expect(page.locator("[data-jarvis-orb] canvas, [data-jarvis-orb] svg")).not.toHaveCount(0);

    await page.getByRole("button", { name: "Complete urgent reply" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "alert");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "conversation");

    await page.getByRole("button", { name: "Complete reply with automatic tender mood" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "tender");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "automatic");
    await expect(page.getByRole("img", { name: /jarvis visual core, tender mood/i })).toBeVisible();

    await page.getByRole("button", { name: "Expire automatic mood" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "focused");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "conversation");

    await page.getByRole("button", { name: "Complete reply with automatic tender mood" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "tender");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "automatic");
    await page.getByRole("button", { name: "Switch to another thread" }).click();
    await expect(surface).toHaveAttribute("data-thread", "thread-b");
    await expect(surface).toHaveAttribute("data-jarvis-mood", "alert");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "conversation");
    await page.getByRole("button", { name: "Complete reply with near-expiry tender mood" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "tender");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "automatic");
    await page.getByRole("button", { name: "Deliver delayed thread A mood" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "tender");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "automatic");
    await page.waitForTimeout(1_400);
    await expect(surface).toHaveAttribute("data-jarvis-mood", "focused");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "conversation");

    await page.getByRole("button", { name: "Choose manual serious mood" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "serious");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "manual");
    await page.getByRole("button", { name: "Return to automatic" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "focused");
    await expect(surface).toHaveAttribute("data-jarvis-mood-source", "conversation");
    await page.screenshot({ path: testInfo.outputPath("orb-mood-priority.png"), fullPage: true });

    expect(unsafeRequests).toEqual([]);
  });

  test("eases the actual fallback colour without movement when reduced motion is requested", async ({ page }, testInfo) => {
    const unsafeRequests = await fenceFixtureTraffic(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/orb-mood?reduced=1&fallback=1", { waitUntil: "networkidle" });

    const surface = page.getByRole("main", { name: "Jarvis orb mood fixture" });
    const svg = page.locator("[data-jarvis-orb] svg");
    await expect(surface).toHaveAttribute("data-reduced-motion", "true");
    await expect(svg).toBeVisible();
    const start = await renderedColour(svg);

    await page.getByRole("button", { name: "Complete urgent reply" }).click();
    await expect(surface).toHaveAttribute("data-jarvis-mood", "alert");
    await page.waitForTimeout(180);
    const early = await renderedColour(svg);
    await page.waitForTimeout(2_000);
    const settled = await renderedColour(svg);
    const alert = [255, 84, 112];

    expect(colourDistance(early, alert)).toBeLessThan(colourDistance(start, alert));
    expect(colourDistance(settled, alert)).toBeLessThan(colourDistance(early, alert));
    await page.screenshot({ path: testInfo.outputPath("orb-mood-reduced-colour-transition.png"), fullPage: true });

    expect(unsafeRequests).toEqual([]);
  });
});
