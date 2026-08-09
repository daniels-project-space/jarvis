import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openOwnerSessionToken } from "./open-owner-session";

describe("open Jarvis owner session", () => {
  it("derives one stable server-only capability without exposing the worker secret", () => {
    const first = openOwnerSessionToken("worker-secret");
    expect(first).toBe(openOwnerSessionToken("worker-secret"));
    expect(first).not.toContain("worker-secret");
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(openOwnerSessionToken("different-worker-secret")).not.toBe(first);
  });

  it("fails closed when the server worker capability is missing", () => {
    expect(() => openOwnerSessionToken("")).toThrow(/unavailable/i);
  });
});
