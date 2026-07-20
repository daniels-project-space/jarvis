import { SHALLOW_PROVENANCE_RULE } from "./git-delivery";

export type RepairIncident = {
  source: string;
  message: string;
  signature: string;
  count: number;
  attempts: number;
};

/** A repository-only repair brief; provider publication remains outside the worker. */
export function repairPrompt(incident: RepairIncident, repo: string): string {
  return (
    `SELF-REPAIR (attempt ${incident.attempts}): something in Daniel's system is broken — trace the ROOT CAUSE and fix it. ` +
    `Never paper over symptoms.\n\n` +
    `Incident (source: ${incident.source}, seen ${incident.count}x): ${incident.message}\n\n` +
    `Method: 1) REPRODUCE — hit the live endpoints (e.g. curl https://jarvis-orcin-six.vercel.app/api/...) ` +
    `or read the failing path until you can explain the error. 2) Trace to the underlying cause in the code of ${repo}. ` +
    `3) Apply the MINIMAL correct fix. 4) VALIDATE proportionally: for a small single-file change, re-read your full diff line by line instead of building (the clone has no node_modules; Vercel's build is the gate and a failed provider build auto-files an incident straight back to you). For multi-file or risky changes, run "npm install" then "npx tsc --noEmit" and "npm run build" — they must pass. ` +
    `5) Commit ONLY working code with a title starting "self-repair:". ` +
    `${SHALLOW_PROVENANCE_RULE} Never replace or reparent a persisted shared branch based on a truncated revision walk. ` +
    `If the true fix needs convex/ or src/trigger/ redeploy (you cannot deploy those), still commit and SAY SO plainly. ` +
    `If you cannot find the root cause, do NOT guess-edit — say exactly what you ruled out and what you suspect.`
  );
}
