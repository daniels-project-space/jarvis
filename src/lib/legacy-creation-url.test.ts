import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_CREATION_URL_REDACTION,
  LEGACY_PUBLIC_CREATION_ORIGIN,
  MAX_LEGACY_CREATION_MEDIA_BYTES,
  PRIVATE_CREATION_ASSET_KEY_REDACTION,
  fetchTrustedLegacyCreation,
  legacyCreationLookupUrl,
  redactLegacyCreationUrls,
  trustedLegacyCreationUrl,
} from "./legacy-creation-url";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy creation URL boundary", () => {
  it("accepts only canonical historical Jarvis creation objects", () => {
    const value = `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/2026-08/plan.pdf`;
    expect(trustedLegacyCreationUrl(value)).toBe(value);
  });

  it("rejects credentials, redirectable variants, and other origins", () => {
    for (const value of [
      `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/plan.pdf?download=1`,
      `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/plan.pdf#fragment`,
      `https://token@pub-901f8094a6f04b32a784dc06cf3ebbc3.r2.dev/creations/plan.pdf`,
      `${LEGACY_PUBLIC_CREATION_ORIGIN}/other/plan.pdf`,
      "https://internal.example/creations/plan.pdf",
      "not a URL",
    ]) {
      expect(trustedLegacyCreationUrl(value)).toBeNull();
    }
  });

  it("redacts canonical legacy media URLs nested in saved creation data", () => {
    const url = `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/2026-08/plan.png`;
    const upperCaseUrl = url.replace("https://pub", "HTTPS://PUB");
    const privateKey = "owners/daniel/creations/f47ac10b-58cc-4372-a567-0e02b2c3d479/asset";
    const queryUrl = `${url}?download=1`;
    const escapedUrl = url.replaceAll("/", "\\/");
    const result = redactLegacyCreationUrls(JSON.stringify({ imageUrls: { cover: url, alternate: upperCaseUrl, queryUrl, escapedUrl }, privateKey }));

    expect(result).toContain(LEGACY_CREATION_URL_REDACTION);
    expect(result).toContain(PRIVATE_CREATION_ASSET_KEY_REDACTION);
    expect(result).not.toContain(url);
    expect(result).not.toContain(upperCaseUrl);
    expect(result).not.toContain(queryUrl);
    expect(result).not.toContain(escapedUrl);
    expect(result).not.toContain(privateKey);
    expect(redactLegacyCreationUrls("https://example.com/a\\/b")).toBe("https://example.com/a\\/b");
  });

  it("maps display-only query variants back to the canonical legacy object", () => {
    const url = `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/2026-08/plan.png`;
    expect(legacyCreationLookupUrl(`${url}?download=1#preview`)).toBe(url);
    expect(legacyCreationLookupUrl("https://example.com/creations/plan.png")).toBeNull();
  });

  it("rejects malformed byte ranges before requesting a legacy object", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchTrustedLegacyCreation(
      `${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/2026-08/plan.pdf`,
      "bytes=0-1,4-5",
    );

    expect(response?.status).toBe(416);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a legacy stream that exceeds the cap despite a false length header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_LEGACY_CREATION_MEDIA_BYTES + 1));
        controller.close();
      },
    }), { status: 200, headers: { "content-length": "1" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchTrustedLegacyCreation(`${LEGACY_PUBLIC_CREATION_ORIGIN}/creations/2026-08/plan.pdf`);

    await expect(response?.arrayBuffer()).rejects.toThrow("legacy creation media exceeded size cap");
  });
});
