import { describe, expect, it, vi } from "vitest";
import {
  CODEX_AUTH_GUIDE_PATH,
  CODEX_DEVICE_AUTH_URI,
  openCodexAuthGuideWindow,
} from "./codex-auth-control";

describe("Codex auth browser control", () => {
  it("opens a durable same-origin guide before asynchronous enrollment begins", () => {
    const opened = {} as Window;
    const openWindow = vi.fn(() => opened);

    expect(openCodexAuthGuideWindow(openWindow)).toBe(opened);
    expect(openWindow).toHaveBeenCalledWith(
      CODEX_AUTH_GUIDE_PATH,
      "jarvis-chatgpt-auth",
      "popup,width=560,height=720",
    );
    expect(CODEX_DEVICE_AUTH_URI).toBe("https://auth.openai.com/codex/device");
  });

  it("preserves a popup-blocked result so the visible fallback link can be used", () => {
    expect(openCodexAuthGuideWindow(vi.fn(() => null))).toBeNull();
  });
});
