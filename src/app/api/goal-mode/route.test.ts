import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
  resolveProjectSourceAdmission: vi.fn(),
  cloudProviderAdmissionReadinessAtRuntime: vi.fn(),
  v2AdmissionEnabled: vi.fn(),
  wakeAgentFleet: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: () => ({ authTokenHash: "admin-hash" }),
  isOwnerActor: (actor: { kind?: string }) => actor.kind === "owner",
}));
vi.mock("@/lib/control-session", () => ({
  controlMutation: mock.controlMutation,
  controlQuery: mock.controlQuery,
}));
vi.mock("@/lib/agent-fleet-dispatch", () => ({ wakeAgentFleet: mock.wakeAgentFleet }));
vi.mock("@/lib/goal-mode", () => ({
  routeGoal: () => ({
    kind: "single_repo",
    reason: "bounded route",
    primaryRepo: "daniels-project-space/youtube-studio-ai",
    infrastructureContext: "test",
  }),
}));
vi.mock("@/lib/mission-protocol-rollout", () => ({
  admissionMutationName: () => "goalMode:createV2",
  v2AdmissionEnabled: mock.v2AdmissionEnabled,
}));
vi.mock("@/lib/source-admission-server", () => ({
  resolveProjectSourceAdmission: mock.resolveProjectSourceAdmission,
}));
vi.mock("@/lib/cloud-provider-admission-runtime", () => ({
  cloudProviderAdmissionReadinessAtRuntime: mock.cloudProviderAdmissionReadinessAtRuntime,
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://jarvis.test/api/goal-mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("Goal Mode admission UI ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.controlActor.mockResolvedValue({ kind: "owner" });
    mock.controlQuery.mockResolvedValue("main");
    mock.controlMutation.mockResolvedValue({ missionId: "mission-1", held: false });
    mock.resolveProjectSourceAdmission.mockResolvedValue({
      protocolVersion: 2,
      canonicalProjectId: "youtube-studio-ai",
      repository: "daniels-project-space/youtube-studio-ai",
      sourceProvider: "github",
      sourceBranch: "main",
      sourceRef: "refs/heads/main",
      sourceHeadSha: "a".repeat(40),
      sourceObservedAt: 1_800_000_000_000,
      sourceAdmissionDigest: "b".repeat(64),
    });
    mock.cloudProviderAdmissionReadinessAtRuntime.mockResolvedValue({ ready: true });
    mock.v2AdmissionEnabled.mockReturnValue(true);
    mock.wakeAgentFleet.mockResolvedValue(true);
    const now = Date.now();
    const templateDigest = "e".repeat(64);
    vi.stubEnv("JARVIS_CLOUD_WORKSPACE_PROVIDER", "sandbox0");
    vi.stubEnv("JARVIS_CLOUD_WORKSPACE_TEMPLATE", "node22-codex-0.144.5");
    vi.stubEnv("JARVIS_CLOUD_WORKSPACE_TEMPLATE_DIGEST", templateDigest);
    vi.stubEnv("JARVIS_CLOUD_PROVIDER_DEPLOYMENT_ID", "20260806.9");
    vi.stubEnv("JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT", JSON.stringify({
      keyId: "current",
      signature: "f".repeat(64),
      receipt: {
        schemaVersion: 1,
        provider: "sandbox0",
        deploymentId: "20260806.9",
        template: { identity: "node22-codex-0.144.5", digest: templateDigest },
        probeTime: now - 60_000,
        expiresAt: now + 60 * 60_000,
      },
    }));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("creates and wakes the mission without opening a global fleet panel", async () => {
    const response = await POST(request({
      goal: "Ship the canonical mission admission safely",
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, missionId: "mission-1" });
    expect(mock.controlMutation).toHaveBeenCalledTimes(1);
    expect(mock.controlMutation).toHaveBeenCalledWith(
      "goalMode:createV2",
      expect.objectContaining({
        goal: "Ship the canonical mission admission safely",
        originThreadId: "main",
      }),
    );
    expect(mock.controlMutation).not.toHaveBeenCalledWith(
      "ui:setPanel",
      expect.anything(),
    );
    expect(mock.wakeAgentFleet).toHaveBeenCalledWith("goal:mission-1");
  });

  it("seals and persists the owner's exact safe source branch", async () => {
    const projectAdmission = {
      protocolVersion: 2,
      canonicalProjectId: "youtube-studio-ai",
      repository: "daniels-project-space/youtube-studio-ai",
      sourceProvider: "github",
      sourceBranch: "continuation/youtube-studio-overhaul",
      sourceRef: "refs/heads/continuation/youtube-studio-overhaul",
      sourceHeadSha: "c".repeat(40),
      sourceObservedAt: 1_800_000_000_001,
      sourceAdmissionDigest: "d".repeat(64),
    };
    mock.resolveProjectSourceAdmission.mockResolvedValue(projectAdmission);

    const response = await POST(request({
      goal: "Overhaul YouTube Studio from the exact continuation branch",
      repo: "daniels-project-space/youtube-studio-ai",
      sourceBranch: "continuation/youtube-studio-overhaul",
    }));

    expect(response.status).toBe(201);
    expect(mock.resolveProjectSourceAdmission).toHaveBeenCalledWith(
      "daniels-project-space/youtube-studio-ai",
      "continuation/youtube-studio-overhaul",
    );
    expect(mock.controlMutation).toHaveBeenCalledWith(
      "goalMode:createV2",
      expect.objectContaining({ projectAdmission }),
    );
  });

  it("rejects an invalid explicit source branch before source observation or admission", async () => {
    const response = await POST(request({
      goal: "Overhaul YouTube Studio from the requested continuation branch",
      sourceBranch: "../../main",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Explicit source branch is invalid." });
    expect(mock.resolveProjectSourceAdmission).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
    expect(mock.wakeAgentFleet).not.toHaveBeenCalled();
  });

  it("does not silently discard an explicit branch while v2 admission is inactive", async () => {
    mock.v2AdmissionEnabled.mockReturnValue(false);

    const response = await POST(request({
      goal: "Overhaul YouTube Studio from the requested continuation branch",
      sourceBranch: "continuation/youtube-studio-overhaul",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Explicit source branch requires the v2 mission protocol.",
    });
    expect(mock.resolveProjectSourceAdmission).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
  });

  it("returns a recoverable 503 before source observation, mission creation, or Trigger wake when provider evidence is absent", async () => {
    mock.cloudProviderAdmissionReadinessAtRuntime.mockResolvedValueOnce({ ready: false, code: "missing_receipt" });

    const response = await POST(request({
      goal: "Overhaul YouTube Studio from the exact ready branch",
      sourceBranch: "agent/youtube-autonomy-production",
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "cloud_provider_not_ready",
      reason: "missing_receipt",
      retryable: true,
      error: expect.stringContaining("Cloud worker release, select Verify release"),
    });
    expect(mock.resolveProjectSourceAdmission).not.toHaveBeenCalled();
    expect(mock.controlQuery).not.toHaveBeenCalled();
    expect(mock.controlMutation).not.toHaveBeenCalled();
    expect(mock.wakeAgentFleet).not.toHaveBeenCalled();
  });
});
