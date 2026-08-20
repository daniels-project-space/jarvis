import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mock = vi.hoisted(() => ({
  createProposal: { action: "create" as const, event: { title: "Planning", start: 1, end: 2, allDay: false } },
  sameOrigin: vi.fn(() => true),
  controlActor: vi.fn(async () => ({ kind: "owner", authTokenHash: "owner" })),
  isOwner: vi.fn(() => true),
  verify: vi.fn(),
  getTrip: vi.fn(),
  create: vi.fn(async () => ({ event: { title: "Planning", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z", allDay: false }, created: true })),
  update: vi.fn(async () => ({ event: { title: "Rescheduled", start: "2026-08-20T10:00:00.000Z", end: "2026-08-20T11:00:00.000Z", allDay: false } })),
  remove: vi.fn(async () => ({ id: "jarvisabcdef0123456789", deleted: true })),
  CalendarError: class GoogleCalendarError extends Error {},
}));

const createProposal = mock.createProposal;

vi.mock("@/lib/control-session", () => ({ isSameOriginRequest: mock.sameOrigin }));
vi.mock("@/lib/request-auth", () => ({ controlActor: mock.controlActor, isOwnerActor: mock.isOwner }));
vi.mock("@/lib/google-calendar-approval.server", () => ({ verifyGoogleCalendarApprovalProposal: mock.verify }));
vi.mock("@/lib/travel", () => ({ getTrip: mock.getTrip }));
vi.mock("@/lib/google-calendar", () => ({
  createGooglePrimaryCalendarEvent: mock.create,
  updateManagedGooglePrimaryCalendarEvent: mock.update,
  deleteManagedGooglePrimaryCalendarEvent: mock.remove,
  GoogleCalendarError: mock.CalendarError,
}));

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
  mock.verify.mockReturnValue({ proposal: createProposal });
  mock.getTrip.mockResolvedValue(null);
  mock.create.mockResolvedValue({ event: { title: "Planning", start: "2026-08-20T09:00:00.000Z", end: "2026-08-20T10:00:00.000Z", allDay: false }, created: true });
  mock.update.mockResolvedValue({ event: { title: "Rescheduled", start: "2026-08-20T10:00:00.000Z", end: "2026-08-20T11:00:00.000Z", allDay: false } });
  mock.remove.mockResolvedValue({ id: "jarvisabcdef0123456789", deleted: true });
});

describe("Google Calendar owner approval route", () => {
  it("requires a same-origin owner click before reaching Google", async () => {
    mock.sameOrigin.mockReturnValue(false);
    const response = await POST(request({ token: "token" }));

    expect(response.status).toBe(403);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("writes only the create event sealed in the approved receipt", async () => {
    const response = await POST(request({ token: "signed-receipt" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "create", created: true, event: { title: "Planning" } });
    expect(mock.verify).toHaveBeenCalledWith("signed-receipt");
    expect(mock.create).toHaveBeenCalledWith(createProposal.event);
  });

  it("writes a current Apple Maps approval bound to its saved preflight", async () => {
    const binding = {
      tripId: "creation-apple",
      storage: "creation" as const,
      updatedAt: 1_000,
      sourceKey: "a".repeat(64),
    };
    mock.verify.mockReturnValue({
      proposal: { ...createProposal, appleMapsOfflinePreflight: binding },
    });
    mock.getTrip.mockResolvedValue({
      id: binding.tripId,
      storage: binding.storage,
      doc: {
        offlineMapPreflight: {
          sourceKey: binding.sourceKey,
          updatedAt: binding.updatedAt,
          calendarRefreshRequired: false,
        },
      },
    });

    const response = await POST(request({ token: "current-apple-maps-receipt" }));

    expect(response.status).toBe(200);
    expect(mock.create).toHaveBeenCalledWith(createProposal.event);
  });

  it("rejects an Apple Maps approval once its saved preflight was refreshed", async () => {
    const binding = {
      tripId: "creation-apple",
      storage: "creation" as const,
      updatedAt: 1_000,
      sourceKey: "a".repeat(64),
    };
    mock.verify.mockReturnValue({
      proposal: { ...createProposal, appleMapsOfflinePreflight: binding },
    });
    mock.getTrip.mockResolvedValue({
      id: binding.tripId,
      storage: binding.storage,
      doc: {
        offlineMapPreflight: {
          sourceKey: binding.sourceKey,
          updatedAt: binding.updatedAt + 1,
          calendarRefreshRequired: true,
        },
      },
    });

    const response = await POST(request({ token: "stale-apple-maps-receipt" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/fresh protected Calendar approval/i) });
    expect(mock.getTrip).toHaveBeenCalledWith(binding.tripId, { storage: "creation" });
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("dispatches only the revision-sealed managed update", async () => {
    const proposal = {
      action: "update" as const,
      eventId: "jarvisabcdef0123456789",
      expectedEtag: "\"revision-1\"",
      event: { title: "Rescheduled", start: 3, end: 4, allDay: false },
    };
    mock.verify.mockReturnValue({ proposal });

    const response = await POST(request({ token: "signed-update" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "update", event: { title: "Rescheduled" } });
    expect(mock.update).toHaveBeenCalledWith({ eventId: proposal.eventId, expectedEtag: proposal.expectedEtag, event: proposal.event });
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("dispatches only the revision-sealed managed delete", async () => {
    const proposal = { action: "delete" as const, eventId: "jarvisabcdef0123456789", expectedEtag: "\"revision-1\"" };
    mock.verify.mockReturnValue({ proposal });

    const response = await POST(request({ token: "signed-delete" }));

    await expect(response.json()).resolves.toMatchObject({ ok: true, action: "delete", deleted: true });
    expect(mock.remove).toHaveBeenCalledWith(proposal.eventId, proposal.expectedEtag);
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("does not write if the receipt is invalid or expired", async () => {
    mock.verify.mockImplementation(() => { throw new Error("expired"); });
    const response = await POST(request({ token: "expired-receipt" }));

    expect(response.status).toBe(400);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("asks for a fresh approval when the sealed event revision is stale", async () => {
    mock.verify.mockReturnValue({
      proposal: {
        action: "update",
        eventId: "jarvisabcdef0123456789",
        expectedEtag: "\"revision-1\"",
        event: { title: "Rescheduled", start: 3, end: 4, allDay: false },
      },
    });
    mock.update.mockRejectedValue(new mock.CalendarError("This managed Google Calendar event changed after the approval was prepared."));

    const response = await POST(request({ token: "stale-update" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/fresh calendar change/i) });
  });
});
