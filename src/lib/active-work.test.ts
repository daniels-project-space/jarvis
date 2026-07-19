import { describe, expect, it } from "vitest";
import { isRelevantActiveWork, needsDaniel, relevantActiveWork } from "./active-work";

describe("live work visibility", () => {
  it("shows only work that is executing or genuinely needs Daniel", () => {
    expect(isRelevantActiveWork({ status: "running", visibility: "conversation" })).toBe(true);
    expect(isRelevantActiveWork({ status: "awaiting_approval", visibility: "conversation" })).toBe(true);
    expect(isRelevantActiveWork({ status: "needs_input", visibility: "conversation" })).toBe(true);
    expect(isRelevantActiveWork({ status: "running", visibility: "conversation", agentId: "sentry" })).toBe(true);
    expect(isRelevantActiveWork({ status: "pending", visibility: "conversation" })).toBe(false);
    expect(isRelevantActiveWork({ status: "paused", visibility: "conversation" })).toBe(false);
  });

  it("keeps routine system work out of the conversation surface", () => {
    expect(isRelevantActiveWork({ status: "running", visibility: "system", label: "Paul · repair" })).toBe(false);
    expect(isRelevantActiveWork({ status: "running", agentId: "sentry", task: "Investigate uptime" })).toBe(false);
    expect(isRelevantActiveWork({ status: "needs_input", incidentId: "incident-1" })).toBe(false);
    expect(isRelevantActiveWork({ status: "awaiting_approval", visibility: "system" })).toBe(false);
    expect(isRelevantActiveWork({ status: "running", task: "Routine provider health check" })).toBe(false);
  });

  it("bounds the list and marks decision states", () => {
    const jobs = [
      { status: "running", visibility: "conversation", label: "one" },
      { status: "running", visibility: "conversation", label: "two" },
      { status: "running", visibility: "conversation", label: "three" },
    ];
    expect(relevantActiveWork(jobs, 2).map((job) => job.label)).toEqual(["one", "two"]);
    expect(needsDaniel({ status: "needs_input" })).toBe(true);
    expect(needsDaniel({ status: "running" })).toBe(false);
  });
});
