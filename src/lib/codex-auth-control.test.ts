import { describe, expect, it, vi } from "vitest";
import {
  CODEX_DEVICE_AUTH_URI,
  openCodexDeviceAuthWindow,
} from "./codex-auth-control";

describe("Codex auth browser control", () => {
  it("opens the verified OpenAI device page immediately from the click", () => {
    const opened = {} as Window;
    const openWindow = vi.fn(() => opened);

    expect(openCodexDeviceAuthWindow(openWindow)).toBe(opened);
    expect(openWindow).toHaveBeenCalledWith(
      CODEX_DEVICE_AUTH_URI,
      "jarvis-chatgpt-auth",
      "popup,width=560,height=720",
    );
  });

  it("preserves a popup-blocked result so the visible fallback link can be used", () => {
    expect(openCodexDeviceAuthWindow(vi.fn(() => null))).toBeNull();
  });
});
