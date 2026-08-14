import { expect, test } from "@playwright/test";

test("the real app shows a safe boot shell before auth and Convex can settle", async ({ page, baseURL }) => {
  const localOrigin = new URL(baseURL ?? "http://127.0.0.1:4181").origin;
  const blockedViewerRequests: string[] = [];

  // A fresh browser has no owner cookie. Keep the client auth fallback and all
  // remote connections from completing so this asserts the first real paint,
  // without creating or refreshing a production owner session during a test.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== localOrigin) {
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname === "/api/auth/viewer" && request.method() === "POST") {
      blockedViewerRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("main", { name: "Starting Jarvis" })).toBeVisible();
  await expect(page.getByText("Ready when you are.", { exact: true })).toBeVisible();
  await expect(page.getByText("Securing your private workspace", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Initializing Jarvis")).toHaveCount(0);
  await expect(page.getByLabel("Connecting Jarvis")).toHaveCount(0);
  await expect.poll(() => blockedViewerRequests.length).toBeGreaterThan(0);

  await page.screenshot({ path: "test-results/browser-startup/first-paint.png", fullPage: true });
});
