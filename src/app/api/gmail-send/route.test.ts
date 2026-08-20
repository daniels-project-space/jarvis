import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlActor: vi.fn<() => Promise<{ kind: string; authTokenHash: string } | null>>(async () => ({ kind: "owner", authTokenHash: "owner" })),
  isOwner: vi.fn(() => true),
  verify: vi.fn(() => ({ draftId: "draft-1", to: "friend@example.com", subject: "Hello", preview: "Hi" })),
  send: vi.fn(async () => ({ messageId: "message-1", threadId: "thread-1" })),
  ApprovalError: class GmailSendApprovalError extends Error {},
}));

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor, isOwnerActor: mock.isOwner }));
vi.mock("@/lib/gmail", () => ({ gmailSendDraft: mock.send }));
vi.mock("@/lib/gmail-send-approval.server", () => ({
  GmailSendApprovalError: mock.ApprovalError,
  verifyGmailSendApproval: mock.verify,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://jarvis.test/api/gmail-send", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jarvis.test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.sameOrigin.mockReturnValue(true);
  mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "owner" });
  mock.isOwner.mockReturnValue(true);
  mock.verify.mockReturnValue({ draftId: "draft-1", to: "friend@example.com", subject: "Hello", preview: "Hi" });
  mock.send.mockResolvedValue({ messageId: "message-1", threadId: "thread-1" });
});

describe("Gmail owner send approval route", () => {
  it("requires a same-origin owner click before sending a sealed draft", async () => {
    mock.sameOrigin.mockReturnValue(false);

    const response = await POST(request({ approval: "signed-receipt" }));

    expect(response.status).toBe(403);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("rejects anonymous and guest callers before reading the approval", async () => {
    mock.controlActor.mockResolvedValueOnce(null);
    const anonymous = await POST(request({ approval: "signed-receipt" }));

    expect(anonymous.status).toBe(401);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();

    mock.controlActor.mockResolvedValueOnce({ kind: "guest", authTokenHash: "guest" });
    mock.isOwner.mockReturnValue(false);
    const guest = await POST(request({ approval: "signed-receipt" }));

    expect(guest.status).toBe(403);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("sends only the draft id sealed in the approval receipt", async () => {
    const response = await POST(request({ approval: "signed-receipt" }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "sent",
      to: "friend@example.com",
      subject: "Hello",
      messageId: "message-1",
    });
    expect(mock.verify).toHaveBeenCalledWith("signed-receipt");
    expect(mock.send).toHaveBeenCalledWith("draft-1");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not send when the approval is invalid or expired", async () => {
    mock.verify.mockImplementation(() => { throw new mock.ApprovalError("expired"); });

    const response = await POST(request({ approval: "expired-receipt" }));

    expect(response.status).toBe(400);
    expect(mock.send).not.toHaveBeenCalled();
  });

  it("redacts provider failures and marks the response private", async () => {
    mock.send.mockRejectedValue(new Error("Bearer secret should never reach the owner UI"));

    const response = await POST(request({ approval: "signed-receipt" }));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(payload.error).toContain("Gmail could not send");
    expect(payload.error).not.toContain("Bearer secret");
  });
});
