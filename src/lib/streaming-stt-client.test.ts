import { describe, expect, it } from "vitest";

import { downsamplePcm16ForTest } from "./streaming-stt-client";

describe("self-hosted streaming speech browser PCM", () => {
  it("converts browser mono audio to bounded 16k signed PCM without a vendor SDK", () => {
    const output = new Int16Array(downsamplePcm16ForTest(new Float32Array([-1, 0, 1]), 16_000));
    expect([...output]).toEqual([-32_767, 0, 32_767]);

    const downsampled = new Int16Array(downsamplePcm16ForTest(new Float32Array([0, 1, 0, -1]), 32_000));
    expect(downsampled.length).toBe(2);
    expect(downsampled[0]).toBe(0);
    expect(downsampled[1]).toBe(0);
  });
});
