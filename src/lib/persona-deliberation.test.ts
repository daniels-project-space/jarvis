import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, PERSONA, VOICE_CAPABILITIES } from "./persona";

describe("conversation-before-execution policy", () => {
  it("challenges ambiguous direction without slowing clear reversible work", () => {
    const policy = `${PERSONA}\n${CAPABILITIES}\n${VOICE_CAPABILITIES}`;
    expect(policy).toContain("a discussion is not automatically a work order");
    expect(policy).toContain("ask up to three pointed questions before delegating");
    expect(policy).toContain("Clear routine repairs proceed immediately");
  });

  it.each(["dispatch_agent", "orchestrate", "goal_mode"])("keeps the deliberation gate on %s", (name) => {
    const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");
    const start = source.indexOf(`name: "${name}"`);
    const next = source.indexOf("name:", start + 10);
    expect(source.slice(start, next < 0 ? undefined : next)).toMatch(/explor|direction|success criteria/i);
  });
});
