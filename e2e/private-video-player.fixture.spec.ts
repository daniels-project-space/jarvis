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

test("the native private-video player loads an owner-route-shaped MP4 without an embed", async ({ page }) => {
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

  await page.goto("/private-video", { waitUntil: "networkidle" });
  await expect(page.getByRole("main", { name: "Private video player fixture" })).toBeVisible();
  const player = page.getByLabel("Private video: Fixture travel video");
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute("src", "/api/files/fixture-video");
  await expect(player).toHaveAttribute("preload", "metadata");
  const videoResponse = page.waitForResponse((response) => response.url() === `${fixtureOrigin}/api/files/fixture-video`);
  await player.evaluate((node: HTMLVideoElement) => node.load());
  expect((await videoResponse).status()).toBe(200);
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>("video[aria-label='Private video: Fixture travel video']");
    return Boolean(video && video.readyState >= HTMLMediaElement.HAVE_METADATA);
  });
  expect(await player.evaluate((node: HTMLVideoElement) => ({
    controls: node.controls,
    height: node.videoHeight,
    playsInline: node.playsInline,
    width: node.videoWidth,
  }))).toEqual({ controls: true, height: 90, playsInline: true, width: 160 });
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(unsafeRequests).toEqual([]);
});
