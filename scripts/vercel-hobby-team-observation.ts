const VERCEL_TEAM_OBSERVATION_TIMEOUT_MS = 10_000;

export type VercelWorkloadEligibility = "personal_noncommercial" | "commercial" | "unknown";

export type VercelHobbyTeamObservation = Readonly<{
  teamId: string;
  plan: "hobby";
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unavailable(): Error {
  return new Error("fresh authenticated Vercel Hobby team observation is unavailable");
}

function unscopedReceiptUnavailable(): Error {
  return new Error("Vercel Hobby activation requires immutable receipt-bound personal_noncommercial workload eligibility");
}

/**
 * Obtain a fresh controller-side provider observation without granting receipt
 * authority. The exact team and plan are provider evidence; they are not
 * evidence that a particular workload is eligible for Hobby.
 *
 * The Vercel credential is used only for this fixed-origin request and is
 * never returned to the caller, included in evidence, or sent to a sandbox.
 */
export async function observeFreshAuthenticatedVercelHobbyTeam(
  options: Readonly<{ teamId: string; token: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<VercelHobbyTeamObservation> {
  const teamId = options.teamId;
  if (!teamId || teamId !== teamId.trim() || !options.token || options.token !== options.token.trim()) throw unavailable();

  let response: Response;
  try {
    response = await fetchImpl(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(VERCEL_TEAM_OBSERVATION_TIMEOUT_MS),
    });
  } catch {
    throw unavailable();
  }
  if (!response.ok || response.status !== 200) throw unavailable();

  let team: unknown;
  try {
    team = await response.json();
  } catch {
    throw unavailable();
  }
  if (!record(team) || team.id !== teamId || !record(team.billing) || team.billing.plan !== "hobby") {
    throw unavailable();
  }

  return Object.freeze({ teamId, plan: "hobby" });
}

/**
 * Vercel restricts Hobby to personal, non-commercial use:
 * https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage
 *
 * The v1 provider receipt is reusable for every job on a Trigger deployment:
 * it has no mission, project, or workload-eligibility binding. Consequently a
 * caller-provided eligibility label cannot authorize Hobby receipt issuance,
 * even after the exact team is observed as Hobby. Keep the signing callback
 * structurally unreachable until a controller-signed personal_noncommercial
 * workload binding is included in and verified from the receipt itself.
 */
export async function blockUnscopedVercelHobbyActivation<T>(
  options: Readonly<{
    teamId: string;
    token: string;
    workloadEligibility: VercelWorkloadEligibility;
    issue: () => T;
  }>,
  fetchImpl: typeof fetch = fetch,
): Promise<never> {
  await observeFreshAuthenticatedVercelHobbyTeam(options, fetchImpl);
  // Deliberately do not invoke options.issue. Even an explicit
  // personal_noncommercial value is mutable caller input, not receipt-bound
  // evidence under the current schema.
  throw unscopedReceiptUnavailable();
}
