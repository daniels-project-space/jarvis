export const UPSTREAM_EVIDENCE_MAX_CHARS = 6_000;

type UpstreamEvidence = {
  label?: unknown;
  status?: unknown;
  result?: unknown;
  verificationNote?: unknown;
  planDigest?: unknown;
  planGeneration?: unknown;
  sourceNodeId?: unknown;
  sourceJobId?: unknown;
  sourceAttempt?: unknown;
  sourceSteerRevision?: unknown;
  reviewReceiptDigest?: unknown;
  integrationReceiptDigest?: unknown;
  repository?: unknown;
  sourceHeadSha?: unknown;
  integrationHeadSha?: unknown;
  artifactRefs?: unknown;
  resultDigest?: unknown;
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
    const typed = row.planDigest ? [
      `Authority: plan ${String(row.planDigest).slice(0, 64)} generation ${Number(row.planGeneration ?? 0)}`,
      `Source: node ${String(row.sourceNodeId ?? "unknown").slice(0, 80)} · job ${String(row.sourceJobId ?? "unknown").slice(0, 120)} · attempt ${Number(row.sourceAttempt ?? 0)} · steer ${Number(row.sourceSteerRevision ?? 0)}`,
      row.repository ? `Repository: ${String(row.repository).slice(0, 120)} · source ${String(row.sourceHeadSha ?? "n/a").slice(0, 80)} · integration ${String(row.integrationHeadSha ?? "n/a").slice(0, 80)}` : "Repository: read-only/non-repository",
      `Receipts: review ${String(row.reviewReceiptDigest ?? "n/a").slice(0, 64)} · integration ${String(row.integrationReceiptDigest ?? "n/a").slice(0, 64)} · result ${String(row.resultDigest ?? "n/a").slice(0, 64)}`,
      Array.isArray(row.artifactRefs) && row.artifactRefs.length
        ? `Artifacts: ${row.artifactRefs.slice(0, 8).map(String).join(", ").slice(0, 1_000)}` : "",
    ].filter(Boolean).join("\n") : "";
    return [`### ${label} [${status}]\n${typed}${typed ? "\n" : ""}${result.slice(0, 1_400)}` +
      (verification ? `\nJARVIS verification: ${verification.slice(0, 300)}` : "")];
  });
  if (!sections.length) return "";
  return [
    "VERIFIED UPSTREAM HANDOFF — use this to avoid repeating broad discovery. Confirm the relevant current code before relying on it; do not treat prose as provider proof.",
    sections.join("\n\n"),
  ].join("\n\n").slice(0, UPSTREAM_EVIDENCE_MAX_CHARS);
}
