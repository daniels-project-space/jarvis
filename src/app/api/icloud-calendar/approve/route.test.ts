import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner" })),
  isOwner: vi.fn(() => true),
  configured: vi.fn(() => true),
  verify: vi.fn(),
  create: vi.fn(),
}));

const event = { title: "Planning", start: 1_780_000_000_000, end: 1_780_003_600_000, allDay: false };

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor, isOwnerActor: mock.isOwner }));
vi.mock("@/lib/icloud-calendar-approval.server", () => ({ verifyICloudCalendarApproval: mock.verify }));
vi.mock("@/lib/icloud-calendar", () => ({
  createICloudEvent: mock.create,
  iCloudCalendarConfigured: mock.configured,
}));

import { POST } from "./route";

function request(body: unknown, headers: HeadersInit = {}) {
  return new NextRequest("https://jarvis.test/api/icloud-calendar/approve", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jarvis.test", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.sameOrigin.mockReturnValue(true);
  mock.controlActor.mockResolvedValue({ kind: "owner", authTokenHash: "owner" });
  mock.isOwner.mockReturnValue(true);
  mock.configured.mockReturnValue(true);
  mock.verify.mockReturnValue({ event, nonce: "signedReceiptNonce_123456" });
  mock.create.mockResolvedValue({ ...event, uid: "uid", eventUrl: "https://calendar.test/uid.ics", calendarName: "Home", source: "icloud", created: true });
});

describe("iCloud Calendar owner approval route", () => {
  it("requires a same-origin owner click before any provider work", async () => {
    mock.sameOrigin.mockReturnValue(false);

    const response = await POST(request({ token: "receipt" }));

    expect(response.status).toBe(403);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("fails closed when the iCloud runtime is not configured", async () => {
    mock.configured.mockReturnValue(false);

    const response = await POST(request({ token: "receipt" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not configured/i) });
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("writes only the sealed event and receipt nonce after owner approval", async () => {
    const response = await POST(request({ token: "signed-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "create", created: true, event: { title: "Planning" } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mock.verify).toHaveBeenCalledWith("signed-receipt");
    expect(mock.create).toHaveBeenCalledWith({ ...event, idempotencyKey: "signedReceiptNonce_123456" });
  });

  it("treats a retried nonce-backed write as already present", async () => {
    mock.create.mockResolvedValueOnce({ ...event, uid: "uid", eventUrl: "https://calendar.test/uid.ics", calendarName: "Home", source: "icloud", created: false });

    const response = await POST(request({ token: "same-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, created: false, event: { title: "Planning" } });
    expect(mock.create).toHaveBeenCalledWith({ ...event, idempotencyKey: "signedReceiptNonce_123456" });
  });

  it("does not write when the receipt is invalid", async () => {
    mock.verify.mockImplementation(() => { throw new Error("expired"); });

    const response = await POST(request({ token: "expired" }));

    expect(response.status).toBe(400);
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("accepts only one sealed token field and rejects duplicate or injected fields", async () => {
    const injected = await POST(request({ token: "receipt", event: { title: "Injected" } }));
    expect(injected.status).toBe(400);
    expect(mock.verify).not.toHaveBeenCalled();

    const duplicate = await POST(new NextRequest("https://jarvis.test/api/icloud-calendar/approve", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://jarvis.test" },
      body: '{"token":"first","token":"second"}',
    }));
    expect(duplicate.status).toBe(400);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("bounds the approval request body even without a truthful Content-Length", async () => {
    const response = await POST(new NextRequest("https://jarvis.test/api/icloud-calendar/approve", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://jarvis.test" },
      body: JSON.stringify({ token: "x".repeat(5_100) }),
    }));

    expect(response.status).toBe(413);
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("redacts CalDAV failures", async () => {
    mock.create.mockRejectedValueOnce(new Error("iCloud returned credential and event details"));

    const response = await POST(request({ token: "receipt" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "iCloud Calendar could not add that event. Check the iCloud Calendar connection and prepare a fresh approval.",
    });
  });
});
