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

test("switching cities keeps itinerary tiles, markers, and routes in their own map base", async ({ page }, testInfo) => {
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

  await page.goto("/city-itinerary", { waitUntil: "networkidle" });
  await expect(page.getByRole("main", { name: "Fixture city-scoped itinerary" })).toBeVisible();
  await expect(page.getByText("Amsterdam Museum", { exact: true })).toBeVisible();
  await expect(page.getByText("Amsterdam Market", { exact: true })).toBeVisible();
  await expect(page.getByText("Museum Island", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Visible itinerary map markers")).toContainText("Amsterdam Museum");
  await expect(page.getByLabel("Visible itinerary map markers")).not.toContainText("Museum Island");
  await expect(page.getByLabel("Visible route geometry")).toHaveText("2 route geometry points");
  await expect(page.getByLabel("Visible locked stay")).toHaveText("Amsterdam Canal Stay");
  await expect(page.getByLabel("Visible airport transfer")).toHaveText("Airport transfer: 24 min · 18 km");
  await expect(page.getByLabel("Visible locked activities")).toContainText("Amsterdam Museum");
  await expect(page.getByLabel("Visible locked activities")).not.toContainText("Museum Island");

  await page.getByRole("tab", { name: /Cross-city discussion/ }).click();
  await expect(page.getByText("Canal walk", { exact: true })).toBeVisible();
  await expect(page.getByText("Brandenburg Gate", { exact: true })).toHaveCount(0);
  await expect(page.getByText("route ready", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Visible route geometry")).toHaveText("No city-scoped route geometry");
  await page.screenshot({ path: testInfo.outputPath("amsterdam-city-isolation.png"), fullPage: true });

  await page.getByLabel("Active fixture itinerary city").selectOption("berlin");
  await expect(page.getByText("Museum Island", { exact: true })).toBeVisible();
  await expect(page.getByText("Tiergarten", { exact: true })).toBeVisible();
  await expect(page.getByText("Amsterdam Museum", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Visible itinerary map markers")).toContainText("Museum Island");
  await expect(page.getByLabel("Visible itinerary map markers")).not.toContainText("Amsterdam Museum");
  await expect(page.getByLabel("Visible route geometry")).toHaveText("2 route geometry points");
  await expect(page.getByLabel("Visible locked stay")).toHaveText("No stay locked in Berlin");
  await expect(page.getByLabel("Visible airport transfer")).toHaveText("No city-scoped airport transfer");
  await expect(page.getByLabel("Visible locked activities")).toContainText("Museum Island");
  await expect(page.getByLabel("Visible locked activities")).not.toContainText("Amsterdam Museum");

  await page.getByRole("tab", { name: /Cross-city discussion/ }).click();
  await expect(page.getByText("Brandenburg Gate", { exact: true })).toBeVisible();
  await expect(page.getByText("Canal walk", { exact: true })).toHaveCount(0);
  await expect(page.getByText("route ready", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Visible route geometry")).toHaveText("No city-scoped route geometry");
  await page.screenshot({ path: testInfo.outputPath("berlin-city-isolation.png"), fullPage: true });

  expect(unsafeRequests).toEqual([]);
});
