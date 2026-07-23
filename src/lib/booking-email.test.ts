import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseBookingEmail } from "./booking-email";

describe("booking confirmation parsing", () => {
  it("extracts a confirmed timed flight without keeping the raw email", () => {
    const booking = parseBookingEmail({
      id: "message-1", from: "British Airways <confirm@ba.com>", subject: "Booking confirmation BA123", sentAt: Date.UTC(2026, 6, 1),
      body: "Your flight reservation is confirmed. Flight BA123 departs 12 October 2026 at 14:30. Booking reference: Q7W9E.",
    });
    expect(booking).toMatchObject({ kind: "flight", provider: "Ba", allDay: false, confirmationCode: "Q7W9E", marker: "jarvis-gmail-booking:message-1" });
    expect(booking?.start).toBe(Date.UTC(2026, 9, 12, 14, 30));
  });

  it("recognises an all-day hotel confirmation and rejects cancelled mail", () => {
    expect(parseBookingEmail({
      id: "message-2", from: "Hotel <booking@hotel.example>", subject: "Reservation confirmed", sentAt: Date.UTC(2026, 6, 1),
      body: "Your hotel booking is confirmed. Check-in 14 November 2026. Confirmation number: HOTEL-42.",
    })).toMatchObject({ kind: "stay", allDay: true, confirmationCode: "HOTEL-42" });
    expect(parseBookingEmail({ id: "message-3", from: "x@y.com", subject: "Booking cancelled", body: "Your reservation has been cancelled." })).toBeNull();
  });
});
