type DeliveryRow = {
  verificationVerdict?: unknown;
  deliveryStatus?: unknown;
  deliveredHeadSha?: unknown;
  mergeCommitSha?: unknown;
  providerRelease?: {
    phase?: unknown;
    headSha?: unknown;
    mergeSha?: unknown;
    steps?: Array<{ status?: unknown }>;
  } | null;
};

/** Convex's last line of defense against a controller caller regression. */
export function verifiedDeliveryCanFinalize(row: DeliveryRow): boolean {
  if (row.verificationVerdict !== "pass") return true;
  if (["pull_request", "blocked", "provider_release", "provider_ready", "provider_postmerge"].includes(String(row.deliveryStatus ?? ""))) {
    if (row.deliveryStatus !== "merged") return false;
  }
  const release = row.providerRelease;
  if (!release) return true;
  return release.phase === "live"
    && row.deliveryStatus === "merged"
    && row.deliveredHeadSha === release.headSha
    && row.mergeCommitSha === release.mergeSha
    && Array.isArray(release.steps)
    && release.steps.length > 0
    && release.steps.every((step) => step.status === "verified");
}
