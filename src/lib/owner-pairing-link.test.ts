import { describe, expect, it } from "vitest";
import { ownerPairingTicketFromLocation, ownerPairingUrl } from "./owner-pairing-link";

describe("click-safe owner pairing links", () => {
  it("reads a query ticket when an in-app browser strips fragments", () => {
    expect(ownerPairingTicketFromLocation("", "?ticket=owner_ticket-123")).toBe("owner_ticket-123");
  });

  it("keeps old fragment links valid without letting a query override them", () => {
    expect(ownerPairingTicketFromLocation("#fragment-ticket", "?ticket=query-ticket")).toBe("fragment-ticket");
  });

  it("creates a single-use URL without a fragile fragment", () => {
    const url = ownerPairingUrl("https://jarvis-orcin-six.vercel.app", "owner_ticket-123");
    expect(url).toBe("https://jarvis-orcin-six.vercel.app/pair?ticket=owner_ticket-123");
    expect(new URL(url).hash).toBe("");
  });
});
