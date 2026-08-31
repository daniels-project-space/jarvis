import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createLocalSttTicket, verifyLocalSttTicket } from "./local-stt-ticket.server";

describe("direct final speech tickets", () => {
  const secret = "local-speech-ticket-test-secret";
  const now = 1_760_000_000_000;

  it("is short-lived, origin-bound, audience-bound, and tamper evident", () => {
    const created = createLocalSttTicket({ secret, origin: "https://jarvis.example", now });
    expect(created.expiresAt).toBe(now + 60_000);
    expect(verifyLocalSttTicket({ ticket: created.ticket, secret, now })).toMatchObject({
      aud: "jarvis-final-stt",
      origin: "https://jarvis.example",
    });
    expect(verifyLocalSttTicket({ ticket: `${created.ticket}x`, secret, now })).toBeNull();
    expect(verifyLocalSttTicket({ ticket: created.ticket, secret: "wrong", now })).toBeNull();
    expect(verifyLocalSttTicket({ ticket: created.ticket, secret, now: created.expiresAt })).toBeNull();
  });

  it("does not mint capabilities for an unsafe origin", () => {
    expect(() => createLocalSttTicket({ secret, origin: "http://jarvis.example", now })).toThrow();
    expect(() => createLocalSttTicket({ secret, origin: "https://jarvis.example/a", now })).toThrow();
  });
});
