export const UPSTREAM_EVIDENCE_MAX_CHARS = 6_000;

type UpstreamEvidence = {
  label?: unknown;
  status?: unknown;
  result?: unknown;
  verificationNote?: unknown;
};

export function upstreamEvidencePrompt(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const sections = value.slice(-8).flatMap((entry): string[] => {
    const row = (entry ?? {}) as UpstreamEvidence;
    const result = String(row.result ?? "").trim();
    if (!result) return [];
    const label = String(row.label ?? "Upstream workstream").slice(0, 120);
    const status = String(row.status ?? "done").slice(0, 32);
    const verification = String(row.verificationNote ?? "").trim();
    return [
      `### ${label} [${status}]\n${result.slice(0, 1_400)}` +
        (verification ? `\nJARVIS verification: ${verification.slice(0, 300)}` : ""),
    ];
  });
  if (!sections.length) return "";
  return [
    "VERIFIED UPSTREAM HANDOFF — use this to avoid repeating broad discovery. Confirm the relevant current code before relying on it; do not treat prose as provider proof.",
    sections.join("\n\n"),
  ].join("\n\n").slice(0, UPSTREAM_EVIDENCE_MAX_CHARS);
}

