import { describe, expect, it } from "vitest";
import {
  codexSessionUnavailableCode,
  controllerSessionStatusPresentation,
} from "./codex-session-status";

describe("controller session status", () => {
  it("extracts only known, bounded controller-session failure codes", () => {
    expect(codexSessionUnavailableCode(
      "JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: re-enrol the controller-managed ChatGPT session",
    )).toBe("rotation_uncertain");
    expect(codexSessionUnavailableCode(
      "prefix JARVIS_CODEX_SESSION_UNAVAILABLE[session_store_unavailable]: restore private store",
    )).toBe("session_store_unavailable");
    expect(codexSessionUnavailableCode(
      "JARVIS_CODEX_SESSION_UNAVAILABLE[untrusted_new_code]: do something",
    )).toBeNull();
    expect(codexSessionUnavailableCode({ message: "rotation_uncertain" })).toBeNull();
  });

  it("keeps a clear status honest and gives repair holds an owner-actionable explanation", () => {
    expect(controllerSessionStatusPresentation("clear")).toMatchObject({
      label: "no repair hold",
      tone: "ready",
    });
    expect(controllerSessionStatusPresentation("repair_required", "rotation_uncertain")).toMatchObject({
      label: "repair needed",
      tone: "attention",
    });
    expect(controllerSessionStatusPresentation("repair_required", "rotation_uncertain").hint)
      .toContain("rotation_uncertain");
  });
});
