import { describe, expect, it } from "vitest";
import { upstreamEvidencePrompt, UPSTREAM_EVIDENCE_MAX_CHARS } from "./upstream-evidence";

describe("upstream mission evidence", () => {
  it("gives downstream workers a bounded verified handoff", () => {
    const prompt = upstreamEvidencePrompt([{
      label: "Secure core",
      status: "done",
      result: "Signed sessions, scoped assets, outbox traces, and CI are implemented.",
      verificationNote: "Supervisor verified the branch and deterministic checks.",
    }]);
    expect(prompt).toContain("avoid repeating broad discovery");
    expect(prompt).toContain("Secure core [done]");
    expect(prompt).toContain("JARVIS verification");
    expect(prompt.length).toBeLessThanOrEqual(UPSTREAM_EVIDENCE_MAX_CHARS);
  });

  it("does not invent a handoff for missing evidence", () => {
    expect(upstreamEvidencePrompt(undefined)).toBe("");
    expect(upstreamEvidencePrompt([{ label: "Empty" }])).toBe("");
  });
});

