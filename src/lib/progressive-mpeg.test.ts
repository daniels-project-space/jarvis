import { afterEach, describe, expect, it, vi } from "vitest";
import { supportsProgressiveMpegPlayback } from "./progressive-mpeg";

describe("supportsProgressiveMpegPlayback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires the browser to explicitly accept raw MP3 Media Source playback", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaSource", { isTypeSupported: vi.fn((mime: string) => mime === "audio/mpeg") });
    expect(supportsProgressiveMpegPlayback()).toBe(true);
  });

  it("keeps the fully-buffered fallback when Media Source is absent or rejects MP3", () => {
    vi.stubGlobal("window", {});
    expect(supportsProgressiveMpegPlayback()).toBe(false);
    vi.stubGlobal("Audio", class {});
    vi.stubGlobal("MediaSource", { isTypeSupported: () => false });
    expect(supportsProgressiveMpegPlayback()).toBe(false);
  });
});
