import { describe, expect, it } from "vitest";
import { controllerSessionStatusFromRows } from "./controllerSession";

describe("controller session control-plane status", () => {
  it("surfaces only a real needs-input controller hold", () => {
    expect(controllerSessionStatusFromRows([
      {
        status: "needs_input",
        active: true,
        controllerSessionRepairRequired: true,
        controllerSessionHoldCode: "rotation_uncertain",
      },
    ])).toEqual({ state: "repair_required", code: "rotation_uncertain" });

    expect(controllerSessionStatusFromRows([
      {
        status: "running",
        active: true,
        controllerSessionRepairRequired: true,
        controllerSessionHoldCode: "rotation_uncertain",
      },
      {
        status: "needs_input",
        active: false,
        controllerSessionRepairRequired: true,
        controllerSessionHoldCode: "rotation_uncertain",
      },
    ])).toEqual({ state: "clear" });
  });

  it("recognizes a legacy held job's bounded operator signal without treating task text as status", () => {
    expect(controllerSessionStatusFromRows([
      {
        status: "needs_input",
        active: true,
        task: "Explain JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: in plain English",
      },
    ])).toEqual({ state: "clear" });

    expect(controllerSessionStatusFromRows([
      {
        status: "needs_input",
        active: true,
        progress: "Jarvis needs repair. JARVIS_CODEX_SESSION_UNAVAILABLE[rotation_uncertain]: re-enrol the managed session",
      },
    ])).toEqual({ state: "repair_required", code: "rotation_uncertain" });
  });
});
