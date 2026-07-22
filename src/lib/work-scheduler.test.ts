import { describe, expect, it } from "vitest";
import { FOREGROUND_QUEUE } from "../trigger/foreground-policy";
import {
  BACKGROUND_CONCURRENCY_LIMIT,
  BACKGROUND_QUEUE,
  MAX_ACTIVE_PER_WORK_GROUP,
  selectFairWork,
  workGroupAuthority,
  type FairWorkCandidate,
} from "./work-scheduler";

const candidate = (
  id: string,
  groupKey: string,
  priority: number,
  writeLineage: string | null = null,
): FairWorkCandidate => ({ id, groupKey, priority, createdAt: Number(id.replace(/\D/g, "") || 0), writeLineage });

describe("durable fair work scheduling", () => {
  it("derives authority from immutable ledger and repository ids, never labels or branch pointers", () => {
    const ledger = {
      _id: "job-1", planParentMissionId: "mission-root", missionId: "project-child",
      repo: "daniels-project-space/jarvis",
    };
    const firstDisplay = { ...ledger, label: "first", branch: "latest-a" };
    const secondDisplay = { ...ledger, label: "identical", branch: "latest-b" };
    const authority = workGroupAuthority(firstDisplay);
    expect(workGroupAuthority(secondDisplay)).toEqual(authority);
    expect(authority).toMatchObject({
      missionGroupId: "mission-root",
      projectGroupId: "project-child",
      projectRepository: "daniels-project-space/jarvis",
    });
    expect(workGroupAuthority({ ...ledger, planParentMissionId: "mission-other" }).schedulingGroupKey)
      .not.toBe(authority.schedulingGroupKey);
  });

  it("gives two new groups capacity while bounding a group with more than eight ready children", () => {
    const ready = [
      ...Array.from({ length: 10 }, (_, index) => candidate(`a-${index}`, "group-a", 50)),
      candidate("b-1", "group-b", 50),
      candidate("c-1", "group-c", 50),
    ];
    const selected = selectFairWork(ready, new Map(), new Set(), BACKGROUND_CONCURRENCY_LIMIT);
    const counts = selected.reduce<Record<string, number>>((result, row) => {
      result[row.groupKey] = (result[row.groupKey] ?? 0) + 1;
      return result;
    }, {});
    expect(selected).toHaveLength(BACKGROUND_CONCURRENCY_LIMIT);
    expect(counts).toEqual({ "group-a": MAX_ACTIVE_PER_WORK_GROUP, "group-b": 1, "group-c": 1 });
  });

  it("uses priority as a fair tie-break without starving a low-priority group", () => {
    const ready = [candidate("high-1", "high", 100), candidate("high-2", "high", 100), candidate("low-1", "low", 1)];
    const first = selectFairWork(ready, new Map(), new Set(), 1);
    expect(first.map((row) => row.id)).toEqual(["high-1"]);
    const second = selectFairWork(ready.filter((row) => row.id !== "high-1"), new Map([
      ["high", { lastServedSequence: 1, activeCount: 0 }],
      ["low", { lastServedSequence: 0, activeCount: 0 }],
    ]), new Set(), 1);
    expect(second.map((row) => row.id)).toEqual(["low-1"]);
  });

  it("allows independent same-repository writers but never overlaps one write lineage", () => {
    const independent = selectFairWork([
      candidate("mission-a", "mission-a-project", 50, "workspace:a"),
      candidate("mission-b", "mission-b-project", 50, "workspace:b"),
    ], new Map(), new Set(), 2);
    expect(independent).toHaveLength(2);

    const shared = selectFairWork([
      candidate("shared-1", "one-project", 50, "integration:one-project"),
      candidate("shared-2", "one-project", 50, "integration:one-project"),
    ], new Map(), new Set(), 2);
    expect(shared.map((row) => row.id)).toEqual(["shared-1"]);
  });

  it("keeps foreground conversation outside the saturated background queue", () => {
    expect(BACKGROUND_QUEUE).not.toBe(FOREGROUND_QUEUE);
    expect(BACKGROUND_CONCURRENCY_LIMIT).toBe(8);
  });
});
