import { expect, test } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4179";

test("the secure private PDF preview keeps a distinct owner download control", async ({ page }) => {
  const previewResponse = page.waitForResponse((response) => response.url() === `${fixtureOrigin}/api/files/fixture-pdf`);
  await page.goto("/private-pdf", { waitUntil: "networkidle" });

  await expect(page.getByRole("main", { name: "Private PDF viewer fixture" })).toBeVisible();
  await expect(page.getByTitle("Fixture itinerary")).toHaveAttribute("src", "/api/files/fixture-pdf");
  const download = page.getByRole("link", { name: "⬇ download" });
  await expect(download).toHaveAttribute("href", "/api/files/fixture-pdf?download=1");

  const preview = await previewResponse;
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toBe("application/pdf");
  expect(preview.headers()["content-disposition"]).toContain("inline");

  const downloadEvent = page.waitForEvent("download");
  await download.click();
  expect((await downloadEvent).suggestedFilename()).toBe("fixture-itinerary.pdf");
});
