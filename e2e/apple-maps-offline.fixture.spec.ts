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

test("renders the saved Apple Maps preflight as a truthful device handoff", async ({ page }, testInfo) => {
  const unsafeRequests: string[] = [];
  page.on("request", (request) => {
    if (!isSafeFixtureRequest(request.method(), request.url())) unsafeRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route("**/*", async (route) => {
    if (!isSafeFixtureRequest(route.request().method(), route.request().url())) return await route.abort("blockedbyclient");
    await route.continue();
  });

  await page.goto("/offline-map", { waitUntil: "networkidle" });
  const card = page.getByRole("region", { name: "Apple Maps offline preflight" });
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "Open Apple Maps for Seville" })).toHaveAttribute(
    "href",
    "https://maps.apple.com/search?query=Seville",
  );
  await expect(card).toContainText("Jarvis reminder is scheduled.");
  await expect(card).toContainText("Matching Hub to-do is already saved.");
  await expect(card).toContainText("Connect Google Calendar");
  await expect(card).toContainText("Download and deletion remain in Maps");
  await expect(card).not.toContainText(/downloaded|deleted/i);
  await page.screenshot({ path: testInfo.outputPath("apple-maps-offline.png"), fullPage: true });
  expect(unsafeRequests).toEqual([]);
});
