import { expect, test, type Page } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4179";

async function fenceFixtureTraffic(page: Page) {
  const unsafeRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method()) || url.origin !== fixtureOrigin) unsafeRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["GET", "HEAD"].includes(request.method()) || url.origin !== fixtureOrigin) return await route.abort("blockedbyclient");
    await route.continue();
  });
  return unsafeRequests;
}

test("renders and navigates the real file hierarchy without remote traffic", async ({ page }, testInfo) => {
  const unsafeRequests = await fenceFixtureTraffic(page);
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/file-workspace", { waitUntil: "networkidle" });
  await expect(page.getByRole("main", { name: "Jarvis file workspace fixture" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Smart file collections" })).toBeVisible();
  await expect(page.getByText("6 indexed")).toBeVisible();

  await page.getByRole("button", { name: "Projects" }).first().click();
  await page.getByRole("button", { name: "Jarvis" }).first().click();
  await expect(page.getByText("launch-brief.md", { exact: true })).toBeVisible();
  await page.getByText("launch-brief.md", { exact: true }).click();
  await expect(page.getByLabel("Name")).toHaveValue("launch-brief.md");
  await page.screenshot({ path: testInfo.outputPath("file-workspace-desktop.png"), fullPage: true });

  await page.getByPlaceholder("Find names, folders, text, tags").fill("roadmap");
  await expect(page.getByText("roadmap.md", { exact: true })).toBeVisible();
  expect(unsafeRequests).toEqual([]);
});
