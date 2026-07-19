import { describe, expect, it } from "vitest";
import { normalizeIncidentSignature } from "./incident-signature";

describe("incident signature normalization", () => {
  it("deduplicates provider request ids and deployment chunk hashes", () => {
    const first = normalizeIncidentSignature(
      "client: Uncaught [CONVEX Q(ui:getSay)] [Request ID: f50bc666d1ff7c80] at https://jarvis.test/_next/static/chunks/first.js:2",
    );
    const second = normalizeIncidentSignature(
      "client: Uncaught [CONVEX Q(ui:getSay)] [Request ID: 295a44b5a0b59159] at https://jarvis.test/_next/static/chunks/second.js:2",
    );
    expect(first).toBe(second);
    expect(first).not.toMatch(/f50bc|295a44|first\.js|second\.js/);
  });

  it("preserves the stable fault identity", () => {
    expect(normalizeIncidentSignature("client: TypeError: orb.render is not a function"))
      .toBe("client: TypeError: orb.render is not a function");
  });
});
