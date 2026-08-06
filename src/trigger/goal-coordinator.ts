import { schedules } from "@trigger.dev/sdk/v3";
import { wakeAgentFleet } from "../lib/agent-fleet-dispatch";
import {
  createGoalCoordinatorReceipt,
  goalCoordinationDemand,
  goalCoordinatorDeploymentVersion,
  recordGoalCoordinatorReceipt,
  syncExternalGoalControls,
  syncExternalGoalRevisions,
  syncExternalGoalRuns,
} from "./goal-runtime";

// Cheap five-minute supervision keeps multi-day goals moving without booting a
// full GitHub/Codex workspace merely to poll an external factory record. The
// hourly GitHub schedule remains a final dead-man switch.
export const goalCoordinator = schedules.task({
  id: "jarvis-goal-coordinator",
  cron: "*/30 * * * *",
  maxDuration: 60,
  run: async (_payload, { ctx }) => {
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
    const woken = shouldWake ? await wakeAgentFleet("goal-coordinator").catch(() => false) : false;
    const receipt = await recordGoalCoordinatorReceipt(createGoalCoordinatorReceipt({
      deploymentVersion: goalCoordinatorDeploymentVersion(ctx.run.version),
      demand,
      controls,
      revisions,
      external,
      shouldWake,
      woken,
    })).then(() => ({ recorded: true })).catch((error) => ({ recorded: false, error: String(error).slice(0, 1000) }));
    return { external, controls, revisions, demand, woken, receipt };
  },
});
