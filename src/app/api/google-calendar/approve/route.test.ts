import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner" })),
  isOwner: vi.fn(() => true),
  verify: vi.fn(() => ({ title: "Planning", start: 1, end: 2, allDay: false })),
  create: vi.fn(async () => ({ event: { title: "Planning", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z", allDay: false }, created: true })),
}));

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor, isOwnerActor: mock.isOwner }));
vi.mock("@/lib/google-calendar-approval.server", () => ({ verifyGoogleCalendarApproval: mock.verify }));
vi.mock("@/lib/google-calendar", () => ({ createGooglePrimaryCalendarEvent: mock.create }));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://jarvis.test/api/google-calendar/approve", {
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
  mock.verify.mockReturnValue({ title: "Planning", start: 1, end: 2, allDay: false });
  mock.create.mockResolvedValue({ event: { title: "Planning", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z", allDay: false }, created: true });
});

describe("Google Calendar owner approval route", () => {
  it("requires a same-origin owner click before reaching Google", async () => {
    mock.sameOrigin.mockReturnValue(false);
    const response = await POST(request({ token: "token" }));

    expect(response.status).toBe(403);
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("writes only the event sealed in the approved receipt", async () => {
    const response = await POST(request({ token: "signed-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, created: true, event: { title: "Planning" } });
    expect(mock.verify).toHaveBeenCalledWith("signed-receipt");
    expect(mock.create).toHaveBeenCalledWith({ title: "Planning", start: 1, end: 2, allDay: false });
  });

  it("does not write if the receipt is invalid or expired", async () => {
    mock.verify.mockImplementation(() => { throw new Error("expired"); });
    const response = await POST(request({ token: "expired-receipt" }));

    expect(response.status).toBe(400);
    expect(mock.create).not.toHaveBeenCalled();
  });
});
