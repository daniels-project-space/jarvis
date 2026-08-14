export type NovitaPatchProposerStatus =
  | "checking"
  | "attestation_not_configured"
  | "attestation_invalid"
  | "runtime_config_digest_mismatch"
  | "attestation_ready"
  | "unavailable";

export function isNovitaPatchProposerStatus(value: unknown): value is Exclude<NovitaPatchProposerStatus, "checking" | "unavailable"> {
  return value === "attestation_not_configured"
    || value === "attestation_invalid"
    || value === "runtime_config_digest_mismatch"
    || value === "attestation_ready";
}

export function novitaPatchProposerStatusPresentation(status: NovitaPatchProposerStatus): {
  label: string;
  hint: string;
  tone: "neutral" | "ready" | "attention";
} {
  switch (status) {
    case "attestation_ready":
      return {
        label: "attested ✓",
        hint: "Only bounded, low-risk owned-code drafts may be admitted. The worker credential stays sealed and Terra reviews every proposal.",
        tone: "ready",
      };
    case "attestation_not_configured":
      return {
        label: "disabled",
        hint: "No immutable Novita configuration attestation is deployed, so Jarvis will not schedule or contact the delegate.",
        tone: "attention",
      };
    case "attestation_invalid":
      return {
        label: "needs review",
        hint: "The sealed Novita configuration is malformed or outside the strict safety limits. Delegate traffic remains off.",
        tone: "attention",
      };
    case "runtime_config_digest_mismatch":
      return {
        label: "needs redeploy",
        hint: "The endpoint configuration does not match its immutable attestation. The worker blocks provider traffic until both match.",
        tone: "attention",
      };
    case "unavailable":
      return {
        label: "check later",
        hint: "Novita draft status could not be checked. Jarvis keeps the delegate off until configuration evidence is available.",
        tone: "attention",
      };
    case "checking":
      return {
        label: "checking…",
        hint: "Checking the sealed Novita configuration without contacting the provider.",
        tone: "neutral",
      };
  }
}
