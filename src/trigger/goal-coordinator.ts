import { schedules } from "@trigger.dev/sdk/v3";
import { wakeAgentHarness } from "../lib/agent-harness-wake";
import {
  goalCoordinationDemand,
  recordGoalCoordinatorReceipt,
  syncExternalGoalControls,
  syncExternalGoalRevisions,
  syncExternalGoalRuns,
} from "./goal-runtime";

const HARNESS_WORKFLOW = "https://github.com/daniels-project-space/jarvis/actions/workflows/jarvis-agent-harness.yml";

function deploymentVersion(): string {
  return String(process.env.TRIGGER_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "unversioned").slice(0, 160);
}

// Cheap five-minute supervision keeps multi-day goals moving without booting a
// full GitHub/Codex workspace merely to poll an external factory record. The
// hourly GitHub schedule remains a final dead-man switch.
export const goalCoordinator = schedules.task({
  id: "jarvis-goal-coordinator",
  cron: "*/5 * * * *",
  maxDuration: 60,
  run: async () => {
    // Controls precede revisions so a paused mission cannot be reactivated by
    // a stale factory repair. Poll only after both outboxes settle.
    const controls = await syncExternalGoalControls()
      .catch((error) => ({ checked: 0, applied: 0, blocked: 0, error: String(error) }));
    const revisions = await syncExternalGoalRevisions()
      .catch((error) => ({ checked: 0, applied: 0, blocked: 0, error: String(error) }));
    const [external, demand] = await Promise.all([
      syncExternalGoalRuns().catch((error) => ({ checked: 0, updated: 0, blocked: 0, wake: false, error: String(error) })),
      goalCoordinationDemand().catch((error) => ({ needed: false, reasons: [], error: String(error) })),
    ]);
    const shouldWake = external.wake || demand.needed === true;
    const woken = shouldWake ? await wakeAgentHarness("goal-coordinator").catch(() => false) : false;
    const receipt = await recordGoalCoordinatorReceipt({
      deploymentVersion: deploymentVersion(),
      demand: {
        needed: demand.needed === true,
        reasons: Array.isArray(demand.reasons) ? demand.reasons.map(String).slice(0, 12) : [],
        error: "error" in demand && demand.error ? String(demand.error).slice(0, 1000) : undefined,
      },
      controls,
      revisions,
      external,
      wakeRequested: shouldWake,
      wakeResult: shouldWake ? (woken ? "dispatched" : "not_dispatched") : "not_requested",
      wakeWorkflow: shouldWake ? HARNESS_WORKFLOW : undefined,
      wakeRef: shouldWake ? "main" : undefined,
      wakeReason: shouldWake ? "goal-coordinator" : undefined,
    }).then(() => ({ recorded: true })).catch((error) => ({ recorded: false, error: String(error).slice(0, 1000) }));
    return { external, controls, revisions, demand, woken, receipt };
  },
});
