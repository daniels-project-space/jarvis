import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createStreamingSttTicket, verifyStreamingSttTicket } from "./streaming-stt-ticket.server";

describe("self-hosted streaming speech tickets", () => {
  const secret = "streaming-ticket-test-secret";
  const now = 1_760_000_000_000;

  it("is short-lived, origin-bound, and rejects changes", () => {
    const created = createStreamingSttTicket({ secret, origin: "https://jarvis.example", now });
    expect(created.expiresAt).toBe(now + 60_000);
    expect(verifyStreamingSttTicket({ ticket: created.ticket, secret, now })).toMatchObject({
      aud: "jarvis-streaming-stt",
      origin: "https://jarvis.example",
    });
    expect(verifyStreamingSttTicket({ ticket: `${created.ticket}x`, secret, now })).toBeNull();
    expect(verifyStreamingSttTicket({ ticket: created.ticket, secret: "wrong", now })).toBeNull();
    expect(verifyStreamingSttTicket({ ticket: created.ticket, secret, now: created.expiresAt })).toBeNull();
  });

  it("does not create tickets for a non-web origin", () => {
    expect(() => createStreamingSttTicket({ secret, origin: "http://jarvis.example", now })).toThrow();
    expect(() => createStreamingSttTicket({ secret, origin: "https://jarvis.example/a", now })).toThrow();
  });
});
