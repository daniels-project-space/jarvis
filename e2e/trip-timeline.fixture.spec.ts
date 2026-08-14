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

test.describe("TripTimeline fixture", () => {
  test("renders a real route, switches days, and keeps unavailable routing honest without external traffic", async ({ page }, testInfo) => {
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

    await page.goto("/", { waitUntil: "networkidle" });

    await expect(page.getByRole("main", { name: "Fixture trip itinerary" })).toBeVisible();
    await expect(page.getByText("Local fixture · no connected data")).toBeVisible();
    await expect(page.getByText("route ready", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Transfer to Riverside Market")).toHaveText("↓walk · 12 min · 700 m");
    await expect(page.getByText("OpenStreetMap / OSRM", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("ready-route.png"), fullPage: true });

    const controls = page.getByLabel("Edit active itinerary day");
    await expect(controls).toBeVisible();
    await page.getByLabel("Time for Riverside Market").fill("13:15");
    await page.getByLabel("Transport mode").selectOption("driving");
    await page.getByRole("button", { name: "Move Riverside Market earlier" }).click();
    await page.getByLabel("Add activity to active day").selectOption("Canal Gallery");
    await page.getByRole("button", { name: "add" }).click();
    await expect(page.getByLabel("Time for Canal Gallery")).toBeVisible();
    await page.getByRole("button", { name: "save route & times" }).click();
    await expect(page.getByLabel("Last synthetic save payload")).toHaveText(
      '{"activities":["Riverside Market","City Museum","Canal Gallery"],"times":["13:15","10:00",""],"transport_mode":"driving"}',
    );

    await page.getByRole("button", { name: "lock day" }).click();
    await expect(page.getByLabel("Last synthetic lock payload")).toHaveText("true");
    await expect(page.getByLabel("Transport mode")).toBeDisabled();
    await expect(page.getByRole("button", { name: "unlock day" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("controls-locked.png"), fullPage: true });
    await page.getByRole("button", { name: "unlock day" }).click();
    await expect(page.getByLabel("Last synthetic lock payload")).toHaveText("false");

    await page.getByRole("tab", { name: /Sat 13 Sep/ }).click();
    await expect(page.getByRole("tab", { name: /Sat 13 Sep/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("route unavailable", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Itinerary timeline").getByText("Hill Park", { exact: true })).toBeVisible();
    await expect(page.getByText("time tbd", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/Transfer to /)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("route-unavailable.png"), fullPage: true });

    expect(unsafeRequests).toEqual([]);
  });
});
