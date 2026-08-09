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

  it("parses a Booking.com-style HTML confirmation with address and local timezone", () => {
    const booking = parseBookingEmail({
      id: "booking-sevilla-html",
      from: "Booking.com <customer.service@booking.com>",
      subject: "Booking confirmation: Hotel Casa 1800 Sevilla",
      sentAt: Date.UTC(2026, 7, 1),
      body: `
        <h1>Your booking is confirmed</h1>
        <p>Property: Hotel Casa 1800 Sevilla</p>
        <p>Property address:</p>
        <div>Rodrigo Caro, 6</div><div>41004 Sevilla</div><div>Spain</div>
        <p>Check-in: Sunday 9 August 2026 from 15:00</p>
        <p>Check-out: Wednesday 12 August 2026 until 11:00</p>
        <p>Timezone: Europe/Madrid</p>
        <p>Booking number: 491827364</p>
      `,
    });
    expect(booking).toMatchObject({
      kind: "stay",
      bookingName: "Hotel Casa 1800 Sevilla",
      location: "Rodrigo Caro, 6, 41004 Sevilla, Spain",
      timeZone: "Europe/Madrid",
      confirmationCode: "491827364",
      allDay: false,
    });
    expect(booking?.start).toBe(Date.UTC(2026, 7, 9, 13, 0));
    expect(booking?.end).toBe(Date.UTC(2026, 7, 12, 9, 0));
  });

  it("prefers deterministic JSON-LD reservation details over surrounding email copy", () => {
    const booking = parseBookingEmail({
      id: "booking-sevilla-jsonld",
      from: "Booking.com <customer.service@booking.com>",
      subject: "Your Booking.com reservation is confirmed",
      body: `
        <p>Confirmed — see your stay below.</p>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "LodgingReservation",
          "reservationNumber": "BKG-SEV-42",
          "checkinTime": "2026-08-09T15:00:00+02:00",
          "checkoutTime": "2026-08-12T11:00:00+02:00",
          "timeZone": "Europe/Madrid",
          "reservationFor": {
            "@type": "LodgingBusiness",
            "name": "Palacio Villapanés",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "Calle Santiago, 31",
              "postalCode": "41003",
              "addressLocality": "Sevilla",
              "addressCountry": "Spain"
            }
          }
        }
        </script>
      `,
    });
    expect(booking).toMatchObject({
      kind: "stay",
      bookingName: "Palacio Villapanés",
      location: "Calle Santiago, 31, 41003, Sevilla, Spain",
      confirmationCode: "BKG-SEV-42",
      start: Date.UTC(2026, 7, 9, 13, 0),
      end: Date.UTC(2026, 7, 12, 9, 0),
    });
  });
});
