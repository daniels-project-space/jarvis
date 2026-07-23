import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlMutation: vi.fn(),
  controlQuery: vi.fn(),
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
    primaryRepo: "daniels-project-space/jarvis",
    infrastructureContext: "test",
  }),
}));
vi.mock("@/lib/mission-protocol-rollout", () => ({
  admissionMutationName: () => "goalMode:createV2",
  v2AdmissionEnabled: () => false,
}));
vi.mock("@/lib/source-admission-server", () => ({ resolveProjectSourceAdmission: vi.fn() }));

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
    mock.wakeAgentFleet.mockResolvedValue(true);
  });

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
});
