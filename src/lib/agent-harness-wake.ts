const OWNER = "daniels-project-space";
const REPO = "jarvis";
const WORKFLOW = "jarvis-agent-harness.yml";
const ACTIVE_RUN_STATES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

async function harnessAlreadyAwake(token: string): Promise<boolean> {
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=10`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      cache: "no-store",
    },
  );
  if (!response.ok) return false;
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload?.workflow_runs)
    && payload.workflow_runs.some((run: any) => ACTIVE_RUN_STATES.has(String(run?.status ?? "")));
}

// Shared by Next server routes and Trigger jobs. The durable job remains in
// Convex; this is only an idempotent wake signal for the cloud Codex harness.
export async function wakeAgentHarness(reason: string): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return false;
  // Several cheap supervisors can discover the same runnable lease on the same
  // minute. Do not boot another GitHub workspace while one is already starting
  // or working; Convex claim fencing remains the final race-safe authority.
  if (await harnessAlreadyAwake(token).catch(() => false)) return false;
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main", inputs: { reason: reason.slice(0, 80) } }),
      cache: "no-store",
    },
  );
  return response.status === 204;
}
