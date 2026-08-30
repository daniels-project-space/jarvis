import { expect, test, type Page } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4179";

type MapRect = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

function isSafeFixtureRequest(method: string, url: string) {
  try {
    const parsed = new URL(url);
    return (method === "GET" || method === "HEAD") && parsed.origin === fixtureOrigin;
  } catch {
    return false;
  }
}

async function fenceFixtureTraffic(page: Page) {
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
  return unsafeRequests;
}

function mapRectsOverlap(left: MapRect, right: MapRect) {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

async function openWorkMapFromKeyboard(page: Page) {
  const trigger = page.getByRole("button", { name: /open jarvis work map/i });
  await trigger.focus();
  await expect(trigger).toBeFocused();

  const summary = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === fixtureOrigin && url.pathname === "/api/work-map/summary";
  });
  await page.keyboard.press("Enter");

  const close = page.getByRole("button", { name: "Close contextual Jarvis work map" });
  await expect(close).toBeFocused();
  await expect(page.locator("[data-work-map]")).toBeVisible();
  expect((await summary).status()).toBe(200);

  return { close, trigger };
}

test.describe("work map bubble fixture", () => {
  test("moves keyboard focus from its trigger into the map and restores it after Escape", async ({ page }, testInfo) => {
    const unsafeRequests = await fenceFixtureTraffic(page);

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/work-map", { waitUntil: "networkidle" });
    await expect(page.getByRole("main", { name: "Jarvis work map fixture" })).toBeVisible();
    const { trigger } = await openWorkMapFromKeyboard(page);
    await page.locator("[data-work-map-category=projects]").click();
    await page.locator("[data-work-map-item=project\\:fixture-project-jarvis]").click();
    await expect(page.locator("[data-work-map-leaves=project\\:fixture-project-jarvis]")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("work-map-desktop-expanded.png"), fullPage: true });

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-work-map]")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(unsafeRequests).toEqual([]);
  });

  test("keeps the small contextual dot set collision-free and anchored when motion is reduced", async ({ page }, testInfo) => {
    const unsafeRequests = await fenceFixtureTraffic(page);

    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [375, 390, 540]) {
      const height = 844;
      await page.setViewportSize({ width, height });
      await page.goto("/work-map?reduced=1", { waitUntil: "networkidle" });
      await expect(page.locator("html")).toHaveClass(/jarvis-reduce-motion/);
      await expect(page.locator("[data-work-map-context] button[data-work-map-category]")).toHaveCount(3);
      await openWorkMapFromKeyboard(page);

      const layout = await page.locator("[data-work-map]").evaluate((surface) => {
        const map = surface.getBoundingClientRect();
        const pulseAnimations = Array.from(surface.querySelectorAll<HTMLElement>(".work-map-pulse"))
          .map((element) => getComputedStyle(element).animationName);
        const categories = Array.from(surface.querySelectorAll<HTMLButtonElement>("button[data-work-map-category]"))
          .map((category) => {
            const rect = category.getBoundingClientRect();
            const layer = category.parentElement?.getBoundingClientRect();
            const computed = getComputedStyle(category);
            const offset = (value: string, size: number) => value.endsWith("%")
              ? Number.parseFloat(value) * size / 100
              : Number.parseFloat(value);
            return {
              id: category.dataset.workMapCategory ?? "unknown",
              anchorX: (layer?.left ?? 0) + offset(computed.left, layer?.width ?? 0),
              anchorY: (layer?.top ?? 0) + offset(computed.top, layer?.height ?? 0),
              centerX: rect.left + rect.width / 2,
              centerY: rect.top + rect.height / 2,
              rect: { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top },
            };
          });
        return {
          categories,
          map: { height: map.height, left: map.left, top: map.top, width: map.width },
          pulseAnimations,
        };
      });

      expect(layout.categories).toHaveLength(6);
      expect(new Set(layout.categories.map((category) => category.id)).size).toBe(6);
      expect(layout.map.left + layout.map.width / 2).toBeCloseTo(width / 2, 1);
      expect(layout.map.top + layout.map.height / 2).toBeCloseTo(height / 2, 1);
      expect(layout.pulseAnimations).not.toHaveLength(0);
      expect(new Set(layout.pulseAnimations)).toEqual(new Set(["none"]));

      for (const category of layout.categories) {
        expect(Math.abs(category.centerX - category.anchorX)).toBeLessThanOrEqual(1);
        expect(Math.abs(category.centerY - category.anchorY)).toBeLessThanOrEqual(1);
      }
      for (let left = 0; left < layout.categories.length; left += 1) {
        for (let right = left + 1; right < layout.categories.length; right += 1) {
          expect(mapRectsOverlap(layout.categories[left].rect, layout.categories[right].rect)).toBe(false);
        }
      }

      if (width === 375) {
        await page.screenshot({ path: testInfo.outputPath("work-map-phone-375-reduced.png"), fullPage: true });
      }
      if (width === 390) {
        await page.screenshot({ path: testInfo.outputPath("work-map-mobile-reduced.png"), fullPage: true });
      }
    }

    expect(unsafeRequests).toEqual([]);
  });
});
