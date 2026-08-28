import { expect, test, type Page } from "@playwright/test";

const fixtureOrigin = new URL("http://127.0.0.1:4179").origin;

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
    if (!isSafeFixtureRequest(request.method(), request.url())) {
      unsafeRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!isSafeFixtureRequest(request.method(), request.url())) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return unsafeRequests;
}

test.describe("compact work fixture", () => {
  test("keeps the default status surface bounded and opens all work through the accessible more control", async ({ page }, testInfo) => {
    const unsafeRequests = await fenceFixtureTraffic(page);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/compact-work", { waitUntil: "networkidle" });
    await expect(page.getByRole("main", { name: "Jarvis compact work fixture" })).toBeVisible();
    await expect(page.locator("[data-fleet-surface=collapsed]")).toBeVisible();
    await expect(page.locator("[data-work-card]")).toHaveCount(2);
    await expect(page.locator("[data-work-more]")).toHaveText("+2 more workview all ›");

    const more = page.getByRole("button", { name: "Open all 4 active Jarvis tasks; 2 more available" });
    await more.focus();
    await expect(more).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("compact-work-bounded.png"), fullPage: true });

    await page.keyboard.press("Enter");
    await expect(page.locator("[data-fleet-surface=expanded]")).toBeVisible();
    await expect(page.locator("[data-active-job]")).toHaveCount(4);
    await expect(page.locator("[data-fleet-surface=collapsed]")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("compact-work-expanded.png"), fullPage: true });

    expect(unsafeRequests).toEqual([]);
  });
});
