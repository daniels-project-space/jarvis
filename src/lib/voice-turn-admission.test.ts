import { describe, expect, it } from "vitest";
import { resolveVoiceTurnAdmission } from "./voice-turn-admission";

describe("resolveVoiceTurnAdmission", () => {
  it("keeps ordinary conversation serialized", () => {
    expect(resolveVoiceTurnAdmission({ foregroundBusy: false, hasFastDispatch: false })).toBe("foreground");
    expect(resolveVoiceTurnAdmission({ foregroundBusy: true, hasFastDispatch: false })).toBe("blocked");
  });

  it("lets only a deterministic specialist handoff continue behind active work", () => {
    expect(resolveVoiceTurnAdmission({ foregroundBusy: false, hasFastDispatch: true })).toBe("fast-dispatch");
    expect(resolveVoiceTurnAdmission({ foregroundBusy: true, hasFastDispatch: true })).toBe("background-dispatch");
  });
});
