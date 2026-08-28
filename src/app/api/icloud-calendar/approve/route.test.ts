import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner" })),
  isOwner: vi.fn(() => true),
  configured: vi.fn(() => true),
  verify: vi.fn(),
  verifyTravel: vi.fn(),
  create: vi.fn(),
  writeTravel: vi.fn(),
  withAdminSession: vi.fn(async (_tokenHash: string | undefined, fn: () => unknown) => await fn()),
  query: vi.fn(),
  mutation: vi.fn(),
  Conflict: class ICloudCalendarConflictError extends Error {},
}));

const event = { title: "Planning", start: 1_780_000_000_000, end: 1_780_003_600_000, allDay: false };

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor, isOwnerActor: mock.isOwner }));
vi.mock("@/lib/control-context", () => ({ withAdminSession: mock.withAdminSession }));
vi.mock("@/lib/context", () => ({ convexQuery: mock.query, convexMutation: mock.mutation }));
vi.mock("@/lib/icloud-calendar-approval.server", () => ({
  verifyICloudCalendarApproval: mock.verify,
  verifyICloudCalendarTravelApproval: mock.verifyTravel,
}));
vi.mock("@/lib/icloud-calendar", () => ({
  createICloudEvent: mock.create,
  iCloudCalendarConfigured: mock.configured,
  writeICloudTravelCalendarEvent: mock.writeTravel,
  ICloudCalendarConflictError: mock.Conflict,
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
  mock.verifyTravel.mockImplementation(() => { throw new Error("not a travel receipt"); });
  mock.verify.mockReturnValue({ event, nonce: "signedReceiptNonce_123456" });
  mock.create.mockResolvedValue({ ...event, uid: "uid", eventUrl: "https://calendar.test/uid.ics", calendarName: "Home", source: "icloud", created: true });
  mock.query.mockResolvedValue({ ok: true });
  mock.mutation.mockImplementation(async (path: string) => {
    if (path === "appleMapsOfflinePreflights:beginICloudCalendarApproval") return { ok: true, committed: false };
    if (path === "appleMapsOfflinePreflights:observeICloudCalendarApproval") return { ok: true, current: true };
    if (path === "appleMapsOfflinePreflights:commitICloudCalendarApproval") return { ok: true };
    return { ok: true };
  });
  mock.writeTravel.mockResolvedValue({
    ...event,
    uid: "travel-uid",
    eventUrl: "https://caldav.icloud.com/123/calendars/home/travel.ics",
    calendarUrl: "https://caldav.icloud.com/123/calendars/home/",
    calendarName: "Home",
    source: "icloud",
    etag: '"etag-2"',
    revision: 1_780_000_000_123,
    created: true,
  });
});

const travelApproval = {
  nonce: "travelReceiptNonce_123456",
  expiresAt: 1_780_000_600_000,
  proposal: {
    action: "create" as const,
    event,
    appleMapsOfflinePreflight: {
      tripId: "j7k3m2n9p4q6r8s1t5u0v2w4x6y8z0ab",
      storage: "creation" as const,
      sourceKey: "a".repeat(64),
      updatedAt: 1_780_000_000_123,
      calendarUrl: "https://caldav.icloud.com/123/calendars/home/",
    },
  },
};

describe("iCloud Calendar owner approval route", () => {
  it("requires a same-origin owner click before any provider work", async () => {
    mock.sameOrigin.mockReturnValue(false);

    const response = await POST(request({ token: "receipt" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.verifyTravel).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("fails closed when the iCloud runtime is not configured", async () => {
    mock.configured.mockReturnValue(false);

    const response = await POST(request({ token: "receipt" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not configured/i) });
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.verifyTravel).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("writes only the sealed event and receipt nonce after owner approval", async () => {
    const response = await POST(request({ token: "signed-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "create", created: true, event: { title: "Planning" } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mock.verify).toHaveBeenCalledWith("signed-receipt");
    expect(mock.create).toHaveBeenCalledWith({ ...event, idempotencyKey: "signedReceiptNonce_123456" });
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.writeTravel).not.toHaveBeenCalled();
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
      error: "iCloud Calendar could not add that event. Check the iCloud Calendar connection, then retry this approval before it expires.",
    });
  });

  it("rechecks the exact owner-sealed saved preflight before an iCloud travel write", async () => {
    mock.verifyTravel.mockReturnValue(travelApproval);
    mock.mutation.mockResolvedValueOnce({ ok: false, reason: "stale" });

    const response = await POST(request({ token: "travel-receipt" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringMatching(/itinerary changed/i),
    }));
    expect(mock.withAdminSession).toHaveBeenCalledWith("owner", expect.any(Function));
    expect(mock.mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:beginICloudCalendarApproval", {
      creationId: travelApproval.proposal.appleMapsOfflinePreflight.tripId,
      sourceKey: travelApproval.proposal.appleMapsOfflinePreflight.sourceKey,
      expectedPreflightUpdatedAt: travelApproval.proposal.appleMapsOfflinePreflight.updatedAt,
      calendarUrl: travelApproval.proposal.appleMapsOfflinePreflight.calendarUrl,
      action: "create",
      nonce: travelApproval.nonce,
    });
    expect(mock.writeTravel).not.toHaveBeenCalled();
    expect(mock.mutation).toHaveBeenCalledTimes(1);
  });

  it("writes and atomically commits only the receipt-bound create", async () => {
    mock.verifyTravel.mockReturnValue(travelApproval);

    const response = await POST(request({ token: "travel-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "create", event: { title: "Planning" } });
    expect(mock.writeTravel).toHaveBeenCalledWith({
      action: "create",
      calendarUrl: travelApproval.proposal.appleMapsOfflinePreflight.calendarUrl,
      sourceKey: travelApproval.proposal.appleMapsOfflinePreflight.sourceKey,
      revision: travelApproval.proposal.appleMapsOfflinePreflight.updatedAt,
      nonce: travelApproval.nonce,
      event,
    });
    expect(mock.mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:beginICloudCalendarApproval", {
      creationId: travelApproval.proposal.appleMapsOfflinePreflight.tripId,
      sourceKey: travelApproval.proposal.appleMapsOfflinePreflight.sourceKey,
      expectedPreflightUpdatedAt: travelApproval.proposal.appleMapsOfflinePreflight.updatedAt,
      calendarUrl: travelApproval.proposal.appleMapsOfflinePreflight.calendarUrl,
      action: "create",
      nonce: travelApproval.nonce,
    });
    expect(mock.mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:observeICloudCalendarApproval", {
      creationId: travelApproval.proposal.appleMapsOfflinePreflight.tripId,
      sourceKey: travelApproval.proposal.appleMapsOfflinePreflight.sourceKey,
      expectedPreflightUpdatedAt: travelApproval.proposal.appleMapsOfflinePreflight.updatedAt,
      calendarUrl: travelApproval.proposal.appleMapsOfflinePreflight.calendarUrl,
      action: "create",
      nonce: travelApproval.nonce,
      calendarEvent: {
        calendarUrl: "https://caldav.icloud.com/123/calendars/home/",
        eventUrl: "https://caldav.icloud.com/123/calendars/home/travel.ics",
        etag: '"etag-2"',
        revision: travelApproval.proposal.appleMapsOfflinePreflight.updatedAt,
        nonce: travelApproval.nonce,
      },
    });
    expect(mock.mutation).toHaveBeenCalledWith("appleMapsOfflinePreflights:commitICloudCalendarApproval", expect.objectContaining({
      action: "create",
      calendarEvent: expect.objectContaining({ etag: '"etag-2"' }),
    }));
  });

  it("does not replay CalDAV when the exact receipt was already durably promoted", async () => {
    mock.verifyTravel.mockReturnValue(travelApproval);
    mock.mutation.mockResolvedValueOnce({ ok: true, committed: true });

    const response = await POST(request({ token: "same-travel-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "create", created: false, event: { title: "Planning" } });
    expect(mock.writeTravel).not.toHaveBeenCalled();
    expect(mock.mutation).toHaveBeenCalledTimes(1);
  });

  it("records the provider ETag before rejecting a post-PUT stale revision", async () => {
    mock.verifyTravel.mockReturnValue(travelApproval);
    mock.mutation
      .mockResolvedValueOnce({ ok: true, committed: false })
      .mockResolvedValueOnce({ ok: false, reason: "stale" });

    const response = await POST(request({ token: "stale-after-put" }));

    expect(response.status).toBe(409);
    expect(mock.writeTravel).toHaveBeenCalledTimes(1);
    expect(mock.mutation).toHaveBeenNthCalledWith(2, "appleMapsOfflinePreflights:observeICloudCalendarApproval", expect.objectContaining({
      calendarEvent: expect.objectContaining({ etag: '"etag-2"' }),
    }));
    expect(mock.mutation).toHaveBeenCalledTimes(2);
  });

  it("uses the sealed ETag for updates and treats a CalDAV 412 conflict as stale", async () => {
    const updateApproval = {
      ...travelApproval,
      proposal: {
        ...travelApproval.proposal,
        action: "update" as const,
        eventUrl: "https://caldav.icloud.com/123/calendars/home/travel.ics",
        expectedEtag: '"etag-1"',
      },
    };
    mock.verifyTravel.mockReturnValue(updateApproval);
    mock.writeTravel.mockRejectedValueOnce(new mock.Conflict("precondition failed"));

    const response = await POST(request({ token: "update-receipt" }));

    expect(response.status).toBe(409);
    expect(mock.writeTravel).toHaveBeenCalledWith(expect.objectContaining({
      action: "update",
      eventUrl: "https://caldav.icloud.com/123/calendars/home/travel.ics",
      expectedEtag: '"etag-1"',
    }));
    expect(mock.mutation).toHaveBeenCalledTimes(1);
  });

  it("returns stale when the durable commit loses its exact preflight revision", async () => {
    mock.verifyTravel.mockReturnValue(travelApproval);
    mock.mutation
      .mockResolvedValueOnce({ ok: true, committed: false })
      .mockResolvedValueOnce({ ok: true, current: true })
      .mockResolvedValueOnce({ ok: false, reason: "stale" });

    const response = await POST(request({ token: "travel-receipt" }));

    expect(response.status).toBe(409);
    expect(mock.writeTravel).toHaveBeenCalledTimes(1);
  });
});
