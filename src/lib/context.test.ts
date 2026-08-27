import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  boundedSnapshot,
  buildContext,
  CONTEXT_INPUT_DEADLINE_MS,
  CONTEXT_LAST_KNOWN_GOOD_MS,
} from "./context";
import { HUB_CONTEXT_URL } from "./hub-context";

describe("bounded foreground context snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("does not wait on optional remote snapshots for a pure conversational reflex", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(buildContext("Hello, Jarvis!")).resolves.toContain("Respond immediately and naturally");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the live-context path for a substantive request with a greeting prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(buildContext("Hey Jarvis, fix the loading spinner")).resolves.toContain("Give the next useful action first");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not fetch Project Hub for unrelated substantive turns", async () => {
    vi.stubEnv("JARVIS_HUB_CONTEXT_TOKEN", "dedicated-jarvis-context-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ value: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await buildContext("Fix the Jarvis voice interruption");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(HUB_CONTEXT_URL))).toBe(false);
  });

  it("still fetches Project Hub for calendar and wealth evidence", async () => {
    vi.stubEnv("JARVIS_HUB_CONTEXT_TOKEN", "dedicated-jarvis-context-token");
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        value: url.startsWith(HUB_CONTEXT_URL)
          ? {
            todos: [{ text: "Renew passport" }],
            events: [{ title: "Design review", start: Date.UTC(2026, 7, 27) }],
            wealth: { currentTotalGBP: 123_456 },
          }
          : null,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const context = await buildContext("What's on my calendar tomorrow, and what is my current wealth?");

    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(HUB_CONTEXT_URL))).toBe(true);
    expect(context).toContain("Renew passport");
    expect(context).toContain("about £123,456");
  });

  it("returns a fresh successful snapshot and records it as last-known-good", async () => {
    let known: { value: unknown; capturedAt: number } | null = null;
    await expect(boundedSnapshot(
      async () => ({ todos: ["ship"] }),
      () => known,
      (next) => { known = next; },
    )).resolves.toEqual({ todos: ["ship"] });
    expect(known).toEqual({ value: { todos: ["ship"] }, capturedAt: Date.now() });
  });

  it("uses only fresh last-known-good data when transport stalls", async () => {
    const controller = new AbortController();
    const stalled = new Promise<unknown>(() => {});
    const result = boundedSnapshot(
      (signal) => {
        signal.addEventListener("abort", () => controller.abort());
        return stalled;
      },
      () => ({ value: { todos: ["known"] }, capturedAt: Date.now() }),
      () => { throw new Error("a timeout must not overwrite last-known-good"); },
    );
    await vi.advanceTimersByTimeAsync(CONTEXT_INPUT_DEADLINE_MS);
    await expect(result).resolves.toEqual({ todos: ["known"] });
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns null when the last-known-good snapshot has expired", async () => {
    const result = boundedSnapshot(
      () => new Promise<unknown>(() => {}),
      () => ({ value: { stale: true }, capturedAt: Date.now() - CONTEXT_LAST_KNOWN_GOOD_MS - 1 }),
      () => { throw new Error("expired data must never be refreshed"); },
    );
    await vi.advanceTimersByTimeAsync(CONTEXT_INPUT_DEADLINE_MS);
    await expect(result).resolves.toBeNull();
  });

  it("gives a second waiter on one stalled shared request its own deadline", async () => {
    const shared = new Promise<unknown>(() => {});
    const lkg = () => ({ value: { snapshot: "fresh-enough" }, capturedAt: Date.now() });
    const first = boundedSnapshot(() => shared, lkg, () => {});
    await vi.advanceTimersByTimeAsync(300);
    const second = boundedSnapshot(() => shared, lkg, () => {});
    await vi.advanceTimersByTimeAsync(CONTEXT_INPUT_DEADLINE_MS);
    await expect(second).resolves.toEqual({ snapshot: "fresh-enough" });
    await expect(first).resolves.toEqual({ snapshot: "fresh-enough" });
  });
});
