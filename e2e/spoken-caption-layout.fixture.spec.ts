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

test.describe("spoken caption layout fixture", () => {
  test("renders the compact, lower caption on mobile and desktop without external traffic", async ({ page }, testInfo) => {
    const unsafeRequests: string[] = [];

    page.on("request", (request) => {
      if (!isSafeFixtureRequest(request.method(), request.url())) {
        unsafeRequests.push([request.method(), request.url()].join(" "));
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

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/caption?mode=main", { waitUntil: "networkidle" });
    const mobileStage = page.locator("[data-caption-stage]");
    const mobileCaption = page.locator("[data-jarvis-caption]");
    await expect(mobileStage).toHaveAttribute("data-caption-layout", "top-[63%] inset-x-0");
    await expect(mobileCaption).toBeVisible();
    const mobile = await mobileStage.evaluate((stage) => {
      const caption = stage.querySelector<HTMLElement>("[data-jarvis-caption]");
      if (!caption) throw new Error("Fixture caption is missing.");
      const rect = stage.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(getComputedStyle(caption).fontSize),
        top: rect.top,
        left: rect.left,
      };
    });
    expect(mobile.fontSize).toBeCloseTo(15.2, 1);
    expect(mobile.top).toBeCloseTo(844 * 0.63, 1);
    expect(mobile.left).toBeCloseTo(0, 1);
    await page.screenshot({ path: testInfo.outputPath("caption-mobile.png"), fullPage: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/caption?mode=compact", { waitUntil: "networkidle" });
    const desktopStage = page.locator("[data-caption-stage]");
    const desktopCaption = page.locator("[data-jarvis-caption]");
    await expect(desktopStage).toHaveAttribute(
      "data-caption-layout",
      "top-[74%] hidden md:flex md:left-[62%] md:right-0",
    );
    await expect(desktopCaption).toBeVisible();
    const desktop = await desktopStage.evaluate((stage) => {
      const caption = stage.querySelector<HTMLElement>("[data-jarvis-caption]");
      if (!caption) throw new Error("Fixture caption is missing.");
      const rect = stage.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(getComputedStyle(caption).fontSize),
        top: rect.top,
        left: rect.left,
      };
    });
    expect(desktop.fontSize).toBeCloseTo(24, 1);
    expect(desktop.top).toBeCloseTo(1_000 * 0.74, 1);
    expect(desktop.left).toBeCloseTo(1_440 * 0.62, 1);
    await page.screenshot({ path: testInfo.outputPath("caption-desktop.png"), fullPage: true });

    expect(unsafeRequests).toEqual([]);
  });
});
