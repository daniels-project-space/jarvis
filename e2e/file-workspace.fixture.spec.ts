import { expect, test, type Page } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4179";

async function fenceFixtureTraffic(page: Page) {
  const unsafeRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    const safe = url.origin === fixtureOrigin && (
      ["GET", "HEAD"].includes(request.method())
      || (request.method() === "PATCH" && url.pathname.startsWith("/api/files/"))
    );
    if (!safe) unsafeRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const safe = url.origin === fixtureOrigin && (
      ["GET", "HEAD"].includes(request.method())
      || (request.method() === "PATCH" && url.pathname.startsWith("/api/files/"))
    );
    if (!safe) return await route.abort("blockedbyclient");
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

  await page.getByRole("button", { name: "Expand Projects" }).click();
  await page.locator('[data-file-folder="Projects"] button').last().click();
  await page.locator('[data-file-folder-card="Projects/Jarvis"]').click();
  await expect(page.getByText("launch-brief.md", { exact: true })).toBeVisible();
  await page.getByText("launch-brief.md", { exact: true }).click();
  await expect(page.getByLabel("Name")).toHaveValue("launch-brief.md");
  await page.screenshot({ path: testInfo.outputPath("file-workspace-desktop.png"), fullPage: true });

  await page.getByPlaceholder("Find names, folders, text, tags").fill("roadmap");
  await expect(page.getByText("roadmap.md", { exact: true })).toBeVisible();
  expect(unsafeRequests).toEqual([]);
});

test("moves one or many files by dropping them onto the collapsible folder tree", async ({ page }, testInfo) => {
  const unsafeRequests = await fenceFixtureTraffic(page);
  let moved: { id: string; folderPath: string } | null = null;
  await page.route("**/api/files/*", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").pop() ?? "";
    const input = request.postDataJSON() as { folderPath?: string };
    moved = { id, folderPath: input.folderPath ?? "" };
    const name = id === "roadmap" ? "roadmap.md" : `${id}.md`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ file: {
        fileId: id,
        name,
        relativePath: `${input.folderPath}/${name}`,
        mimeType: "text/markdown",
        sizeBytes: 8_200,
        status: "ready",
        summary: "Current delivery roadmap and next decisions.",
        tags: ["roadmap"],
        createdAt: Date.now() - 12_000,
        updatedAt: Date.now(),
      } }),
    });
  });

  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/file-workspace", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Expand Projects" }).click();
  await page.locator('[data-file-folder="Projects/Jarvis"] button').last().click();
  await expect(page.locator('[data-workspace-file="roadmap"]')).toBeVisible();
  await page.getByRole("button", { name: "Expand Business" }).click();

  await page.locator('[data-workspace-file="roadmap"]').dragTo(page.locator('[data-file-folder="Business/Acme"]'));
  await expect(page.getByRole("status")).toContainText("Moved 1 file to Business/Acme");
  expect(moved).toEqual({ id: "roadmap", folderPath: "Business/Acme" });
  await expect(page.locator('[data-workspace-file="roadmap"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("file-workspace-drag-move.png"), fullPage: true });
  expect(unsafeRequests).toEqual([]);
});
