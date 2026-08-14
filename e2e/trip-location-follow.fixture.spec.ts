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

test("location following is opt-in, clears its watcher, and only selects a saved city ID", async ({ page }, testInfo) => {
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

  await page.goto("/location", { waitUntil: "networkidle" });
  await expect(page.getByRole("main", { name: "Fixture trip location following" })).toBeVisible();
  await expect(page.getByLabel("Follow my location")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => window.__tripLocationFixture?.watchCount())).toBe(0);

  await page.getByLabel("Follow my location").click();
  await expect.poll(() => page.evaluate(() => window.__tripLocationFixture?.watchCount())).toBe(1);
  await page.evaluate(() => window.__tripLocationFixture?.emit(37.8882, -4.7794));

  await expect(page.getByLabel("Active fixture city")).toHaveText("seville");
  await expect(page.getByLabel("Selection payloads")).toHaveText('[{"city_context_id":"cordoba"}]');
  await expect(page.getByLabel("Selection payloads")).not.toContainText(/lat|lng|accuracy/i);
  await page.evaluate(() => window.__tripLocationFixture?.emit(37.8882, -4.7794));
  await expect(page.getByLabel("Selection payloads")).toHaveText('[{"city_context_id":"cordoba"}]');
  await page.evaluate(() => window.__tripLocationFixture?.commitActiveCity("cordoba"));
  await expect(page.getByLabel("Active fixture city")).toHaveText("cordoba");
  await page.screenshot({ path: testInfo.outputPath("location-following.png"), fullPage: true });

  await page.getByLabel("Stop following my location").click();
  await expect.poll(() => page.evaluate(() => window.__tripLocationFixture?.clearCount())).toBe(1);
  expect(unsafeRequests).toEqual([]);
});
