import { expect, test } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4179";

function isSafeFixtureRequest(method: string, url: string) {
  try {
    const parsed = new URL(url);
    return (method === "GET" || method === "HEAD") && parsed.origin === fixtureOrigin;
  } catch {
    return false;
  }
}

test("a fresh booked location appears only on its active city map", async ({ page }, testInfo) => {
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

  await page.goto("/booking-marker", { waitUntil: "networkidle" });
  await expect(page.getByRole("main", { name: "Fixture booked location map marker" })).toBeVisible();
  await expect(page.getByLabel("Map marker: Booked location · Amsterdam")).toBeVisible();
  await expect(page.getByLabel("Map marker: Suggested stay · Amsterdam")).toHaveCount(0);
  await expect(page.getByLabel("Map marker: Booked location · Berlin")).toHaveCount(0);
  await expect(page.getByLabel("Visible marker count")).toHaveText("1 visible city-scoped marker");
  await page.screenshot({ path: testInfo.outputPath("amsterdam-booked-marker.png"), fullPage: true });

  await page.getByLabel("Active fixture city").selectOption("berlin");
  await expect(page.getByLabel("Map marker: Booked location · Berlin")).toBeVisible();
  await expect(page.getByLabel("Map marker: Suggested stay · Berlin")).toHaveCount(0);
  await expect(page.getByLabel("Map marker: Booked location · Amsterdam")).toHaveCount(0);
  await expect(page.getByLabel("Visible marker count")).toHaveText("1 visible city-scoped marker");
  await page.screenshot({ path: testInfo.outputPath("berlin-booked-marker.png"), fullPage: true });

  expect(unsafeRequests).toEqual([]);
});
