import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, VOICE_CAPABILITIES } from "../lib/persona";

describe("foreground response latency policy", () => {
  it("uses the compact safety-equivalent foreground map instead of the encyclopaedic cold prompt", () => {
    const source = readFileSync(new URL("./chat-session.ts", import.meta.url), "utf8");
    expect(source).toContain("${VOICE_CAPABILITIES}");
    expect(source).not.toContain("${CAPABILITIES}");
    expect(VOICE_CAPABILITIES.length).toBeLessThan(CAPABILITIES.length / 2);
  });

  it("removes dynamic tools only from the exact Luna social lane while preserving Daniel history labels", () => {
    const source = readFileSync(new URL("./chat-session.ts", import.meta.url), "utf8");
    expect(source).toContain("allowTools: !fastLane");
    expect(source).toContain('speaker: "Daniel"');
    expect(source).toContain("This lane is only for an exact greeting, thanks, or acknowledgement");
  });
});
