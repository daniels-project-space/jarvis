const VERCEL_TEAM_OBSERVATION_TIMEOUT_MS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unavailable(): Error {
  return new Error("fresh authenticated Vercel Hobby team observation is unavailable");
}

/**
 * Keep receipt issuance behind a fresh controller-side provider observation.
 * The Vercel credential is used only for this fixed-origin request and is
 * never returned to the caller, included in evidence, or sent to a sandbox.
 */
export async function issueAfterFreshAuthenticatedVercelHobbyTeamObservation<T>(
  options: Readonly<{ teamId: string; token: string; issue: () => T }>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const teamId = options.teamId;
  if (!teamId || teamId !== teamId.trim() || !options.token) throw unavailable();

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

  return options.issue();
}
