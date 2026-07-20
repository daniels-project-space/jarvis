type DeliveryRow = {
  verificationVerdict?: unknown;
  deliveryStatus?: unknown;
  deliveredHeadSha?: unknown;
  providerRelease?: {
    phase?: unknown;
    headSha?: unknown;
    steps?: Array<{ status?: unknown }>;
  } | null;
};

/** Convex's last line of defense against a controller caller regression. */
export function verifiedDeliveryCanFinalize(row: DeliveryRow): boolean {
  if (row.verificationVerdict !== "pass") return true;
  if (["pull_request", "blocked", "provider_release", "provider_ready"].includes(String(row.deliveryStatus ?? ""))) {
    if (row.deliveryStatus !== "merged") return false;
  }
  const release = row.providerRelease;
  if (!release) return true;
  return release.phase === "ready"
    && row.deliveryStatus === "merged"
    && row.deliveredHeadSha === release.headSha
    && Array.isArray(release.steps)
    && release.steps.length > 0
    && release.steps.every((step) => step.status === "verified");
}

