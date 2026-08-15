export type HubActionsStatus = "checking" | "configured" | "needs_setup" | "unavailable";

/** Owner-facing copy for the separate, bounded Project Hub to-do façade. */
export function hubActionsStatusPresentation(status: HubActionsStatus): {
  label: string;
  hint: string;
  tone: "neutral" | "ready" | "attention";
} {
  switch (status) {
    case "configured":
      return {
        label: "configured ✓",
        hint: "Dedicated Project Hub to-do capability is configured. Jarvis uses only the bounded to-do façade.",
        tone: "ready",
      };
    case "needs_setup":
      return {
        label: "needs setup",
        hint: "Add the dedicated Project Hub actions capability. Jarvis will not use a context or broad vault credential to change to-dos.",
        tone: "attention",
      };
    case "unavailable":
      return {
        label: "check later",
        hint: "Project Hub to-do readiness could not be checked. Jarvis makes no Hub to-do changes until its scoped capability is available.",
        tone: "attention",
      };
    case "checking":
      return {
        label: "checking…",
        hint: "Checking whether the dedicated Project Hub to-do capability is available.",
        tone: "neutral",
      };
  }
}
