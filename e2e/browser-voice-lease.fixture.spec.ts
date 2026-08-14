import { expect, test } from "@playwright/test";

const fixtureOrigin = "http://127.0.0.1:4180";

function isSafeFixtureRequest(method: string, url: string) {
  try {
    const parsed = new URL(url);
    return (method === "GET" || method === "HEAD") && parsed.origin === fixtureOrigin;
  } catch {
    return false;
  }
}

test.describe("Browser live microphone lease fixture", () => {
  test("gives copied-session Jarvis documents distinct standby listener identities", async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem("jarvis_client", "copied");
    });
    await page.goto("/voice", { waitUntil: "networkidle" });

    const main = page.frameLocator("iframe[title='Main Jarvis']");
    const overlay = page.frameLocator("iframe[title='Overlay Jarvis']");
    const [mainClient, overlayClient] = await Promise.all([
      main.getByLabel("Standby listener client").textContent(),
      overlay.getByLabel("Standby listener client").textContent(),
    ]);

    expect(mainClient).toBeTruthy();
    expect(overlayClient).toBeTruthy();
    expect(mainClient).not.toBe("copied");
    expect(overlayClient).not.toBe("copied");
    expect(mainClient).not.toBe("unavailable");
    expect(overlayClient).not.toBe("unavailable");
    expect(mainClient).not.toBe(overlayClient);
  });

  test("allows one same-origin Jarvis document to capture, then hands off after stop", async ({ page }) => {
    const unsafeRequests: string[] = [];
    await page.addInitScript(() => {
      const topWindow = window.top as Window & {
        __jarvisVoiceFixtureCalls?: number;
        __jarvisVoiceFixtureFailNext?: boolean;
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            topWindow.__jarvisVoiceFixtureCalls = (topWindow.__jarvisVoiceFixtureCalls ?? 0) + 1;
            if (topWindow.__jarvisVoiceFixtureFailNext) {
              topWindow.__jarvisVoiceFixtureFailNext = false;
              throw new DOMException("blocked", "NotAllowedError");
            }
            return {
              getTracks: () => [{ stop: () => {} }],
            } as unknown as MediaStream;
          },
        },
      });
    });
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

    await page.goto("/voice", { waitUntil: "networkidle" });
    await expect.poll(() => page.evaluate(() => "locks" in navigator)).toBe(true);

    const main = page.frameLocator("iframe[title='Main Jarvis']");
    const overlay = page.frameLocator("iframe[title='Overlay Jarvis']");
    await Promise.all([
      main.getByRole("button", { name: "Start live listening" }).click(),
      overlay.getByRole("button", { name: "Start live listening" }).click(),
    ]);

    await expect.poll(async () => {
      const statuses = await Promise.all([
        main.getByLabel("Live microphone status").textContent(),
        overlay.getByLabel("Live microphone status").textContent(),
      ]);
      return statuses.sort();
    }).toEqual(["busy", "live"]);
    const [mainStatus, overlayStatus] = await Promise.all([
      main.getByLabel("Live microphone status").textContent(),
      overlay.getByLabel("Live microphone status").textContent(),
    ]);
    expect([mainStatus, overlayStatus].sort()).toEqual(["busy", "live"]);
    await expect.poll(() => page.evaluate(() => (window as Window & { __jarvisVoiceFixtureCalls?: number }).__jarvisVoiceFixtureCalls ?? 0)).toBe(1);

    const winner = mainStatus === "live" ? main : overlay;
    const loser = mainStatus === "live" ? overlay : main;
    await winner.getByRole("button", { name: "Stop live listening" }).click();
    await expect(winner.getByLabel("Live microphone status")).toHaveText("stopped");
    await loser.getByRole("button", { name: "Start live listening" }).click();
    await expect(loser.getByLabel("Live microphone status")).toHaveText("live");
    await expect.poll(() => page.evaluate(() => (window as Window & { __jarvisVoiceFixtureCalls?: number }).__jarvisVoiceFixtureCalls ?? 0)).toBe(2);

    expect(unsafeRequests).toEqual([]);
  });

  test("releases the real browser lock when the microphone request fails", async ({ page }) => {
    await page.addInitScript(() => {
      const topWindow = window.top as Window & { __jarvisVoiceFixtureFailNext?: boolean };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (topWindow.__jarvisVoiceFixtureFailNext) {
              topWindow.__jarvisVoiceFixtureFailNext = false;
              throw new DOMException("blocked", "NotAllowedError");
            }
            return { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
          },
        },
      });
    });
    await page.goto("/voice", { waitUntil: "networkidle" });
    await page.evaluate(() => { (window as Window & { __jarvisVoiceFixtureFailNext?: boolean }).__jarvisVoiceFixtureFailNext = true; });

    const main = page.frameLocator("iframe[title='Main Jarvis']");
    const overlay = page.frameLocator("iframe[title='Overlay Jarvis']");
    await main.getByRole("button", { name: "Start live listening" }).click();
    await expect(main.getByLabel("Live microphone status")).toHaveText("microphone failed");
    await overlay.getByRole("button", { name: "Start live listening" }).click();
    await expect(overlay.getByLabel("Live microphone status")).toHaveText("live");
  });
});
