export const WORK_CONTROL_ACTIONS = ["pause", "resume", "cancel", "retry", "steer"] as const;

export type WorkControlAction = (typeof WORK_CONTROL_ACTIONS)[number];
export type WorkControlEventStage = "paused" | "queued" | "cancelled" | "steering";

type WorkControlLanguage = {
  label: WorkControlAction;
  pendingLabel: string;
  pastTense: "paused" | "resumed" | "cancelled" | "retried" | "steered";
  eventStage: WorkControlEventStage;
};

const WORK_CONTROL_LANGUAGE = {
  pause: { label: "pause", pendingLabel: "pausing…", pastTense: "paused", eventStage: "paused" },
  resume: { label: "resume", pendingLabel: "resuming…", pastTense: "resumed", eventStage: "queued" },
  cancel: { label: "cancel", pendingLabel: "cancelling…", pastTense: "cancelled", eventStage: "cancelled" },
  retry: { label: "retry", pendingLabel: "retrying…", pastTense: "retried", eventStage: "queued" },
  steer: { label: "steer", pendingLabel: "steering…", pastTense: "steered", eventStage: "steering" },
} satisfies Record<WorkControlAction, WorkControlLanguage>;

export function isWorkControlAction(action: string): action is WorkControlAction {
  return Object.hasOwn(WORK_CONTROL_LANGUAGE, action);
}

export function workControlLabel(action: WorkControlAction): string {
  return WORK_CONTROL_LANGUAGE[action].label;
}

export function workControlPendingLabel(action: WorkControlAction): string {
  return WORK_CONTROL_LANGUAGE[action].pendingLabel;
}

export function workControlPastTense(action: WorkControlAction): WorkControlLanguage["pastTense"] {
  return WORK_CONTROL_LANGUAGE[action].pastTense;
}

export function workControlEventStage(action: WorkControlAction): WorkControlEventStage {
  return WORK_CONTROL_LANGUAGE[action].eventStage;
}

export function formatWorkControlResult(subject: string, action: WorkControlAction, applied: boolean): string {
  return applied
    ? `${subject} ${workControlLabel(action)} request applied.`
    : `${subject} cannot be ${workControlPastTense(action)} from its current state.`;
}
