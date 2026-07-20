import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_MIGRATION_STEPS_PER_TICK,
  drainControlPlaneMigration,
} from "./control-plane-migration";

describe("Trigger control-plane migration continuation", () => {
  it("continues separate mutation invocations until completion", async () => {
    const advance = vi.fn()
      .mockResolvedValueOnce({ phase: "jobs", complete: false })
      .mockResolvedValueOnce({ phase: "jobs", complete: false })
      .mockResolvedValueOnce({ phase: "missions", complete: true });

    await expect(drainControlPlaneMigration(advance)).resolves.toEqual({
      steps: 3,
      complete: true,
      phase: "missions",
    });
    expect(advance).toHaveBeenCalledTimes(3);
  });

  it("stops at the bounded continuation budget", async () => {
    const advance = vi.fn().mockResolvedValue({ phase: "missions", complete: false });

    await expect(drainControlPlaneMigration(advance, 4)).resolves.toEqual({
      steps: 4,
      complete: false,
      phase: "missions",
    });
    expect(advance).toHaveBeenCalledTimes(4);
    expect(CONTROL_PLANE_MIGRATION_STEPS_PER_TICK).toBe(40);
  });

  it("makes one constant-time confirmation call after durable completion", async () => {
    const advance = vi.fn().mockResolvedValue({ phase: "complete", complete: true });

    await expect(drainControlPlaneMigration(advance)).resolves.toEqual({
      steps: 1,
      complete: true,
      phase: "complete",
    });
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
