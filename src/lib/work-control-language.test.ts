import { describe, expect, it } from "vitest";
import {
  WORK_CONTROL_ACTIONS,
  formatWorkControlResult,
  workControlEventStage,
  workControlLabel,
  workControlPastTense,
  workControlPendingLabel,
  type WorkControlAction,
} from "./work-control-language";

const EXPECTED: Record<WorkControlAction, {
  label: string;
  pending: string;
  past: string;
  stage: string;
}> = {
  pause: { label: "pause", pending: "pausing…", past: "paused", stage: "paused" },
  resume: { label: "resume", pending: "resuming…", past: "resumed", stage: "queued" },
  cancel: { label: "cancel", pending: "cancelling…", past: "cancelled", stage: "cancelled" },
  retry: { label: "retry", pending: "retrying…", past: "retried", stage: "queued" },
  steer: { label: "steer", pending: "steering…", past: "steered", stage: "steering" },
};

describe("work-control language", () => {
  it("maps every control to valid tool-result wording", () => {
    expect(Object.fromEntries(WORK_CONTROL_ACTIONS.map((action) => [action, {
      label: workControlLabel(action),
      pending: workControlPendingLabel(action),
      past: workControlPastTense(action),
    }]))).toEqual(Object.fromEntries(WORK_CONTROL_ACTIONS.map((action) => [action, {
      label: EXPECTED[action].label,
      pending: EXPECTED[action].pending,
      past: EXPECTED[action].past,
    }])));

    for (const action of WORK_CONTROL_ACTIONS) {
      expect(formatWorkControlResult("Job job-1", action, true)).toBe(`Job job-1 ${EXPECTED[action].label} request applied.`);
      expect(formatWorkControlResult("That job", action, false)).toBe(`That job cannot be ${EXPECTED[action].past} from its current state.`);
    }
  });

  it("maps control intent to persisted event state rather than conjugating the action", () => {
    expect(Object.fromEntries(WORK_CONTROL_ACTIONS.map((action) => [action, workControlEventStage(action)]))).toEqual(
      Object.fromEntries(WORK_CONTROL_ACTIONS.map((action) => [action, EXPECTED[action].stage])),
    );
  });
});
