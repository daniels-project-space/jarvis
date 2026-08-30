import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  controlActor: vi.fn(),
  controlCredentials: vi.fn(() => ({ authTokenHash: "owner-hash" })),
  convexQuery: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock("@/lib/request-auth", () => ({
  controlActor: mock.controlActor,
  controlCredentials: mock.controlCredentials,
  isOwnerActor: (actor: { kind?: unknown }) => actor?.kind === "owner",
}));
vi.mock("@/lib/context", () => ({ convexQuery: mock.convexQuery }));
vi.mock("@trigger.dev/sdk/v3", () => ({
  tasks: { trigger: mock.trigger },
}));

import { POST } from "./route";

const request = () => new Request("https://jarvis.test/api/chat/warm", {
  method: "POST",
  headers: { origin: "https://jarvis.test" },
});

describe("foreground voice prewarm route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_800_000);
    delete process.env.JARVIS_FOREGROUND_HOLD_REASON;
    mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "owner-hash" });
    mock.convexQuery.mockResolvedValue(null);
    mock.trigger.mockResolvedValue({ id: "run-prewarm" });
  });

  it("starts one transcript-free foreground runner in a bounded idempotency bucket", async () => {
    const response = await POST(request() as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      warm: false,
      started: true,
    });
    expect(mock.convexQuery).toHaveBeenCalledWith(
      "chatQueue:runnerLease",
      { authTokenHash: "owner-hash" },
    );
    expect(mock.trigger).toHaveBeenCalledWith(
      "jarvis-chat-turn",
      { source: "voice-prewarm" },
      { idempotencyKey: "jarvis-voice-prewarm-30" },
    );
  });

  it("does not spend a second Trigger start while the authoritative runner lease is warm", async () => {
    mock.convexQuery.mockResolvedValue({ updatedAt: Date.now() - 5_000 });

    const response = await POST(request() as never);

    await expect(response.json()).resolves.toEqual({
      ok: true,
      warm: true,
      started: false,
    });
    expect(mock.trigger).not.toHaveBeenCalled();
  });

  it("does not trust an impossible future lease timestamp as a warm runner", async () => {
    mock.convexQuery.mockResolvedValue({ updatedAt: Date.now() + 60_000 });

    const response = await POST(request() as never);

    await expect(response.json()).resolves.toMatchObject({ started: true, warm: false });
    expect(mock.trigger).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unauthenticated, guest, billing-held, and failed starts", async () => {
    mock.controlActor.mockResolvedValueOnce(null);
    expect((await POST(request() as never)).status).toBe(401);

    mock.controlActor.mockResolvedValueOnce({ kind: "guest", guestId: "guest" });
    expect((await POST(request() as never)).status).toBe(403);

    process.env.JARVIS_FOREGROUND_HOLD_REASON = "trigger_billing_limit";
    const held = await POST(request() as never);
    expect(held.status).toBe(503);
    await expect(held.json()).resolves.toMatchObject({
      code: "FOREGROUND_WORKERS_BILLING_PAUSED",
    });
    expect(mock.convexQuery).not.toHaveBeenCalled();
    expect(mock.trigger).not.toHaveBeenCalled();

    delete process.env.JARVIS_FOREGROUND_HOLD_REASON;
    mock.trigger.mockRejectedValueOnce(new Error("Trigger unavailable"));
    expect((await POST(request() as never)).status).toBe(503);
  });
});
