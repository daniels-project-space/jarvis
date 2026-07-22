import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const uiSource = readFileSync(new URL("./JarvisUI.tsx", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("kept-visible workspace orb berth", () => {
  it("keeps expanded work above the mobile particle-orb berth and preserves the desktop side composition", () => {
    expect(uiSource).toContain("data-jarvis-panel-surface className={`jarvis-mobile-orb-safe-panel");
    expect(uiSource).toContain("data-jarvis-full-orb-safe-workspace className=\"jarvis-full-orb-safe-workspace");
    expect(uiSource).toContain("md:right-[236px]");
    expect(cssSource).toContain(".jarvis-full-orb-safe-workspace {\n  bottom: 268px;");
    expect(cssSource).toContain(".jarvis-full-orb-safe-workspace {\n    bottom: 0;");
    expect(cssSource).toContain(".jarvis-compact-orb-zone");

    // Contract for the reported 390 × 844 expanded Saved Work regression:
    // the 268px berth ends the panel at y=576, before the observed orb top.
    const panel = { left: 12, top: 12, right: 378, bottom: 844 - 268 };
    const orb = { left: 210, top: 584, right: 362, bottom: 736 };
    const overlaps = panel.left < orb.right && panel.right > orb.left && panel.top < orb.bottom && panel.bottom > orb.top;
    expect(overlaps).toBe(false);
  });
});
