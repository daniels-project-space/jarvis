import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const fixtureOrigin = "http://127.0.0.1:4179";

function isSafeFixtureRequest(method: string, url: string) {
  try {
    const parsed = new URL(url);
    return (method === "GET" || method === "HEAD") && parsed.origin === fixtureOrigin;
  } catch {
    return false;
  }
}

test("a private mind-map artifact card keeps image view and direct download separate", async ({ page }) => {
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

  await page.goto("/artifact", { waitUntil: "networkidle" });

  await expect(page.getByRole("main", { name: "Artifact card fixture" })).toBeVisible();
  await expect(page.getByText("Seville days · mind map.svg", { exact: true })).toBeVisible();
  await page.getByTitle("show on screen").click();
  await expect(page.getByLabel("Shown artifact")).toHaveText("/api/creation-media?id=fixture-mindmap&variant=asset");

  const downloadLink = page.getByTitle("download file");
  await expect(downloadLink).toHaveAttribute("href", "/api/creation-download?id=fixture-mindmap");
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("seville-days-mind-map.svg");
  expect(download.url()).toBe(`${fixtureOrigin}/api/creation-download?id=fixture-mindmap`);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Fixture artifact did not produce a local download path.");
  expect(await readFile(downloadPath, "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');

  expect(unsafeRequests).toEqual([]);
});
