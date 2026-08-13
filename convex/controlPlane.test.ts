import { describe, expect, it } from "vitest";
import {
  mergeJobRuntimeSource,
  projectJobRuntime,
  projectMissionRuntime,
  runtimeJob,
} from "./controlPlane";

describe("compact control-plane projections", () => {
  it("bounds live job context and excludes durable payloads", () => {
    const projected = projectJobRuntime({
      _id: "job-1",
      task: "t".repeat(2_000),
      label: "l".repeat(200),
      status: "running",
      priority: 150,
      stage: "working",
      percent: 140,
      progress: "p".repeat(2_000),
      dependsOn: Array.from({ length: 30 }, (_, index) => `job-${index}`),
      result: "r".repeat(20_000),
      checkpoint: "c".repeat(20_000),
      log: "x".repeat(20_000),
      acceptanceCriteria: ["large durable detail"],
      createdAt: 100,
    });

    expect(projected).toMatchObject({
      jobId: "job-1",
      status: "running",
      priority: 100,
      percent: 100,
      createdAt: 100,
    });
    expect(projected.task).toHaveLength(600);
    expect(projected.label).toHaveLength(80);
    expect(projected.progress).toHaveLength(400);
    expect(projected.dependsOn).toHaveLength(16);
    expect(projected).not.toHaveProperty("result");
    expect(projected).not.toHaveProperty("checkpoint");
    expect(projected).not.toHaveProperty("log");
    expect(projected).not.toHaveProperty("acceptanceCriteria");
  });

  it("keeps a provider configuration hold out of live capacity while preserving its recovery state", () => {
    const projected = projectJobRuntime({
      _id: "job-held",
      task: "Wait for verified secure worker setup",
      status: "paused",
      providerRunState: "blocked",
      providerObservedAt: 200,
      cloudWorkspaceBlockCode: "missing_configuration",
      stage: "cloud blocked",
      createdAt: 100,
    });

    expect(projected).toMatchObject({
      status: "paused",
      active: false,
      providerRunState: "blocked",
      cloudWorkspaceBlockCode: "missing_configuration",
    });
  });

  it("preserves newer activity across unrelated durable authority writes", () => {
    const durable = {
      _id: "job-1",
      status: "running",
      stage: "starting",
      percent: 2,
      progress: "starting secure workspace",
      heartbeatAt: 100,
      createdAt: 50,
    };
    const activity = {
      stage: "delivery",
      percent: 97,
      progress: "controller delivery in progress",
      heartbeatAt: 500,
      updatedAt: 500,
    };

    expect(mergeJobRuntimeSource(durable, { pullRequestUrl: "https://example.test/pr/1" }, activity)).toMatchObject({
      _id: "job-1",
      stage: "delivery",
      percent: 97,
      progress: "controller delivery in progress",
      heartbeatAt: 500,
      pullRequestUrl: "https://example.test/pr/1",
    });
    expect(mergeJobRuntimeSource(durable, { stage: "paused", progress: "paused by Daniel" }, activity)).toMatchObject({
      stage: "paused",
      progress: "paused by Daniel",
      percent: 97,
      heartbeatAt: 500,
    });
  });

  it("keeps rich mission state out of activity rows", () => {
    const projected = projectMissionRuntime({
      _id: "mission-1",
      goal: "g".repeat(1_000),
      mode: "goal",
      status: "running",
      agentCount: 3,
      failureReason: "f".repeat(1_000),
      plan: { workstreams: Array.from({ length: 20 }, () => ({ detail: "large" })) },
      validationHistory: Array.from({ length: 20 }, () => ({ detail: "large" })),
      summary: "s".repeat(10_000),
      createdAt: 100,
      updatedAt: 200,
    });

    expect(projected.goal).toHaveLength(500);
    expect(projected.failureReason).toHaveLength(600);
    expect(projected).not.toHaveProperty("plan");
    expect(projected).not.toHaveProperty("validationHistory");
    expect(projected).not.toHaveProperty("summary");
  });

  it("keeps legacy UI identity without exposing transcript fields", () => {
    expect(runtimeJob({ jobId: "job-1", status: "running" })).toMatchObject({
      _id: "job-1",
      status: "running",
      log: "",
      checkpoint: null,
    });
  });
});
