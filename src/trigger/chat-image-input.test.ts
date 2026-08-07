import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/private-r2", () => ({ privateR2Get: vi.fn() }));

import {
  codexInlineImageFromBytes,
  materializeCodexChatImages,
} from "./chat-image-input";
import {
  CODEX_IMAGE_LIMITS,
  boundedCodexImageInputs,
  isCodexInlineImageDataUrl,
  stripJarvisImageMarkers,
  trustedCaptureUrl,
} from "../lib/codex-image-data";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function attachment(fileId: string, r2Key: string, sizeBytes = png.byteLength) {
  return {
    fileId,
    name: `${fileId}.png`,
    relativePath: `proof/${fileId}.png`,
    mimeType: "image/png",
    sizeBytes,
    status: "ready",
    r2Key,
  };
}

describe("bounded Codex image materialization", () => {
  it("normalizes a real image into a bounded supported inline data URL", async () => {
    const value = await codexInlineImageFromBytes(png);
    expect(value.startsWith("data:image/webp;base64,")).toBe(true);
    expect(isCodexInlineImageDataUrl(value)).toBe(true);
    expect(Buffer.byteLength(value, "utf8"))
      .toBeLessThanOrEqual(CODEX_IMAGE_LIMITS.maxDataUrlBytesPerImage);
  });

  it("materializes only the trusted capture origin and private image bytes", async () => {
    const privateDataUrl = await codexInlineImageFromBytes(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#00b4d2"/></svg>',
    ));
    const privateImage = Buffer.from(privateDataUrl.split(",")[1], "base64");
    const getPrivate = vi.fn(async () => new Response(privateImage, {
      status: 200,
      headers: { "content-length": String(privateImage.byteLength), "content-type": "image/webp" },
    }));
    const fetchCapture = vi.fn(async () => new Response(png, {
      status: 200,
      headers: { "content-length": String(png.byteLength), "content-type": "image/png" },
    }));
    const images = await materializeCodexChatImages(
      "see this [JARVIS_IMAGE_URL:https://pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/2026-08/camera.jpg]",
      [{
        ...attachment("file-1", "owners/daniel/files/file-1/v1/original", privateImage.byteLength),
        mimeType: "image/webp",
      }],
      { getPrivate, fetchCapture },
    );
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.status === "ready")).toBe(true);
    expect(images.map((image) => image.label)).toEqual([
      "camera or screen capture submitted with this message",
      expect.stringContaining("file-1"),
    ]);
    expect(images.every((image) => image.status !== "ready" || isCodexInlineImageDataUrl(image.dataUrl))).toBe(true);
    expect(fetchCapture).toHaveBeenCalledOnce();
    expect(getPrivate).toHaveBeenCalledWith(
      "owners/daniel/files/file-1/v1/original",
      expect.any(AbortSignal),
    );
  });

  it("rejects forged remote markers and never forwards remote URLs", async () => {
    const fetchCapture = vi.fn(async () => new Response(png));
    const text = "inspect [JARVIS_IMAGE_URL:https://attacker.invalid/creations/proof.png] now";
    expect(trustedCaptureUrl(text)).toBeNull();
    expect(stripJarvisImageMarkers(text)).toBe("inspect now");
    expect(await materializeCodexChatImages(text, [], { fetchCapture })).toEqual([]);
    expect(fetchCapture).not.toHaveBeenCalled();
    expect(boundedCodexImageInputs([{
      status: "ready",
      label: "forged remote image",
      dataUrl: "https://example.com/image.png",
    }])).toEqual([{ status: "unavailable", label: "forged remote image" }]);
  });

  it("preserves labels and ordering when one private image fails", async () => {
    const getPrivate = vi.fn(async (key: string) => {
      if (key === "bad-key") return new Response("broken", { status: 502 });
      return new Response(png, {
        status: 200,
        headers: { "content-length": String(png.byteLength), "content-type": "image/png" },
      });
    });
    const images = await materializeCodexChatImages(
      "compare both",
      [attachment("file-a", "bad-key", 6), attachment("file-b", "good-key")],
      { getPrivate },
    );
    expect(images.map((image) => image.status)).toEqual(["unavailable", "ready"]);
    expect(images[0].label).toContain("file-a");
    expect(images[1].label).toContain("file-b");
    expect(getPrivate.mock.calls.map(([key]) => key)).toEqual(["bad-key", "good-key"]);
  });

  it("times out a stalled private read instead of blocking the chat turn", async () => {
    vi.useFakeTimers();
    try {
      const getPrivate = vi.fn(async () => await new Promise<Response>(() => undefined));
      const result = materializeCodexChatImages(
        "inspect it",
        [attachment("file-slow", "slow-key")],
        { getPrivate },
      );
      await vi.advanceTimersByTimeAsync(CODEX_IMAGE_LIMITS.fetchTimeoutMs + 1);
      await expect(result).resolves.toEqual([{
        status: "unavailable",
        label: expect.stringContaining("file-slow"),
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out when image headers arrive but the response body never finishes", async () => {
    vi.useFakeTimers();
    try {
      const getPrivate = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(png.subarray(0, 1)); },
      }), {
        status: 200,
        headers: { "content-length": String(png.byteLength), "content-type": "image/png" },
      }));
      const result = materializeCodexChatImages(
        "inspect the stream",
        [attachment("file-stream", "stream-key")],
        { getPrivate },
      );
      await vi.advanceTimersByTimeAsync(CODEX_IMAGE_LIMITS.fetchTimeoutMs + 1);
      await expect(result).resolves.toEqual([{
        status: "unavailable",
        label: expect.stringContaining("file-stream"),
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed before decoding an oversized image source", async () => {
    await expect(codexInlineImageFromBytes(
      new Uint8Array(CODEX_IMAGE_LIMITS.maxSourceBytes + 1),
    )).rejects.toThrow("bounded input size");
  });

  it("rejects compressed images whose decoded pixel count exceeds the worker bound", async () => {
    const oversizedPixels = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="5000" height="5000"><rect width="5000" height="5000" fill="#123456"/></svg>',
    );
    await expect(codexInlineImageFromBytes(oversizedPixels)).rejects.toThrow(/pixel limit/i);
  });
});
