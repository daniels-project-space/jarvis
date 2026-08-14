export type HubContextStatus = "checking" | "configured" | "needs_setup" | "unavailable";

export function hubContextStatusPresentation(status: HubContextStatus): {
  label: string;
  hint: string;
  tone: "neutral" | "ready" | "attention";
} {
  switch (status) {
    case "configured":
      return {
        label: "configured ✓",
        hint: "Dedicated read-only Project Hub context capability is configured.",
        tone: "ready",
      };
    case "needs_setup":
      return {
        label: "needs setup",
        hint: "Add the dedicated Project Hub context capability. Jarvis will never use the broad vault credential for Hub data.",
        tone: "attention",
      };
    case "unavailable":
      return {
        label: "check later",
        hint: "Project Hub context status could not be checked. Jarvis leaves Hub context off until its dedicated capability is available.",
        tone: "attention",
      };
    case "checking":
      return {
        label: "checking…",
        hint: "Checking whether the dedicated Project Hub context capability is available.",
        tone: "neutral",
      };
  }
}
