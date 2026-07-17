import "server-only";

const OWNER = "daniels-project-space";
const REPO = "jarvis";
const WORKFLOW = "jarvis-agent-harness.yml";

// Agent jobs live in Convex; this call is only a low-cost wake signal. The
// workflow then leases work atomically, so duplicate dispatches are harmless.
export async function wakeAgentHarness(reason: string): Promise<boolean> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return false;
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

