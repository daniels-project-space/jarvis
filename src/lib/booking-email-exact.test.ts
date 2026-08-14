import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./google-oauth", () => ({ getGoogleAccessToken: vi.fn(async () => "access-token") }));

import { lookupGmailBookingForAppleMapsPreflight } from "./booking-email";

function message(id: string, internalDate: number, body: string) {
  return {
    id, threadId: "flight-thread", internalDate: String(internalDate), snippet: body,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: "Booking confirmation BA123" },
        { name: "From", value: "British Airways <confirm@ba.com>" },
      ],
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("exact Gmail booking lookup for saved Apple Maps preflights", () => {
  it("uses the exact Gmail thread and adopts a newer matching confirmation without a broad booking scan", async () => {
    const initial = message("flight-old", 1_700_000_000_000, "Your flight reservation is confirmed. Flight BA123 departs 12 October 2026 at 14:30. Booking reference: Q7W9E.");
    const replacement = message("flight-new", 1_700_000_100_000, "Your flight reservation is confirmed. Flight BA123 departs 12 October 2026 at 16:30. Booking reference: Q7W9E.");
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("messages/flight-old")) return new Response(JSON.stringify(initial));
      if (url.includes("threads/flight-thread")) return new Response(JSON.stringify({ messages: [initial, replacement] }));
      if (url.includes("messages?q=")) return new Response(JSON.stringify({ messages: [{ id: "flight-old" }, { id: "flight-new" }] }));
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const booking = await lookupGmailBookingForAppleMapsPreflight({
      selectionId: "booking-opaque", messageId: "flight-old", marker: "jarvis-gmail-booking:flight-old",
      threadId: "flight-thread", kind: "flight", provider: "Ba", confirmationCode: "Q7W9E",
    });

    expect(booking).toMatchObject({ id: "flight-new", confirmationCode: "Q7W9E" });
    expect(booking?.start).toBe(Date.UTC(2026, 9, 12, 16, 30));
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain(expect.stringContaining("newer_than:"));
  });
});
