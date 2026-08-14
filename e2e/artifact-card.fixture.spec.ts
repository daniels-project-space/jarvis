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

test("a production artifact card keeps view and download actions separate", async ({ page }) => {
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
  await expect(page.getByText("Fixture report.pdf", { exact: true })).toBeVisible();
  await page.getByTitle("show on screen").click();
  await expect(page.getByLabel("Shown artifact")).toHaveText("/api/creation-media?id=fixture-pdf&variant=asset");

  const downloadLink = page.getByTitle("download file");
  await expect(downloadLink).toHaveAttribute("href", "/api/creation-download?id=fixture-pdf");
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("fixture-report.pdf");
  expect(download.url()).toBe(`${fixtureOrigin}/api/creation-download?id=fixture-pdf`);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Fixture artifact did not produce a local download path.");
  expect(await readFile(downloadPath, "utf8")).toBe("jarvis artifact fixture\n");

  expect(unsafeRequests).toEqual([]);
});
