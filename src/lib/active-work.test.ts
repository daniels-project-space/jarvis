import { describe, expect, it } from "vitest";
import {
  cacheCompactWorkSnapshot,
  needsDaniel,
  visibleCompactWork,
  type CompactWorkCache,
  type CompactWorkItem,
} from "./active-work";

const dispatching: CompactWorkItem = {
  id: "job-1",
  label: "Paul · current repair",
  status: "dispatching",
  stage: "dispatching",
  percent: 2,
};

describe("compact work-bar continuity", () => {
  it("retains one resolved item through an unresolved refresh and state handoff", () => {
    let cache: CompactWorkCache = cacheCompactWorkSnapshot(null, "thread-a", { active: dispatching });
    expect(visibleCompactWork(cache, "thread-a", undefined)).toBe(dispatching);

    const running: CompactWorkItem = { ...dispatching, status: "running", stage: "testing", percent: 64 };
    expect(visibleCompactWork(cache, "thread-a", { active: running })).toBe(running);
    cache = cacheCompactWorkSnapshot(cache, "thread-a", { active: running });
    expect(visibleCompactWork(cache, "thread-a", undefined)).toBe(running);
    expect(visibleCompactWork(cache, "thread-a", undefined)?.id).toBe("job-1");
  });

  it("hides immediately on an explicit empty result and stays hidden on refresh", () => {
    let cache: CompactWorkCache = cacheCompactWorkSnapshot(null, "thread-a", { active: dispatching });
    expect(visibleCompactWork(cache, "thread-a", { active: null })).toBeNull();
    cache = cacheCompactWorkSnapshot(cache, "thread-a", { active: null });
    expect(visibleCompactWork(cache, "thread-a", undefined)).toBeNull();
  });

  it("never carries work into a different conversation", () => {
    const cache = cacheCompactWorkSnapshot(null, "thread-a", { active: dispatching });
    expect(visibleCompactWork(cache, "thread-b", undefined)).toBeNull();
  });

  it("keeps decision states out of the active bar's control path", () => {
    expect(needsDaniel({ status: "awaiting_approval" })).toBe(true);
    expect(needsDaniel({ status: "needs_input" })).toBe(true);
    expect(needsDaniel({ status: "running" })).toBe(false);
  });
});
