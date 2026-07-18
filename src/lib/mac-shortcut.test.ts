import { describe, expect, it } from "vitest";
import { JARVIS_MAC_ENTRY_URL, macShortcutUrl } from "./mac-shortcut";

describe("Mac Shortcut bridge", () => {
  it("builds Apple's documented run-shortcut URL without shell execution", () => {
    expect(macShortcutUrl("Add to Notes", "Buy milk & bread")).toBe(
      "shortcuts://run-shortcut?name=Add+to+Notes&input=text&text=Buy+milk+%26+bread",
    );
  });

  it("uses the canonical cloud entry point", () => {
    expect(JARVIS_MAC_ENTRY_URL).toContain("project-hub-olive-pi.vercel.app/?jarvis=");
  });
});
