import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertPrivateBucketName,
  privateCaptureObjectKey,
  privateCreationObjectKey,
  privateFileAttemptObjectKey,
  privateR2ConfigurationCode,
} from "./private-r2";

describe("private R2 configuration diagnostics", () => {
  it("accepts only the dedicated private bucket", () => {
    expect(assertPrivateBucketName(" jarvis-private-files ")).toBe("jarvis-private-files");
  });

  it("classifies a missing private bucket without exposing credentials", () => {
    try {
      assertPrivateBucketName(undefined);
      throw new Error("expected missing bucket to fail");
    } catch (error) {
      expect(privateR2ConfigurationCode(error)).toBe("bucket_missing");
    }
  });

  it("classifies a mismatched private bucket", () => {
    try {
      assertPrivateBucketName("public-assets");
      throw new Error("expected mismatched bucket to fail");
    } catch (error) {
      expect(privateR2ConfigurationCode(error)).toBe("bucket_mismatch");
    }
  });

  it("builds only opaque creation and capture object keys", () => {
    const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(privateCreationObjectKey(id)).toBe(`owners/daniel/creations/${id}/asset`);
    expect(privateCreationObjectKey(id, "thumb")).toBe(`owners/daniel/creations/${id}/thumb`);
    expect(privateCaptureObjectKey(id)).toBe(`owners/daniel/captures/${id}/image`);
  });

  it("rejects broad or non-opaque creation and capture paths", () => {
    expect(() => privateCreationObjectKey("owners/daniel/files/anything/v1/original")).toThrow("invalid private creation object identity");
    expect(() => privateCaptureObjectKey("capture-1")).toThrow("invalid private capture object identity");
  });

  it("mints derived-output keys only for a bounded attempt namespace", () => {
    const fileId = "file_01A-opaque";
    const attempt = "2-123e4567-e89b-12d3-a456-426614174000";
    expect(privateFileAttemptObjectKey(fileId, 3, attempt, "extracted.txt"))
      .toBe(`owners/daniel/files/${fileId}/v3/a${attempt}/extracted.txt`);
    expect(privateFileAttemptObjectKey(fileId, 3, attempt, "preview.webp"))
      .toBe(`owners/daniel/files/${fileId}/v3/a${attempt}/preview.webp`);
    expect(() => privateFileAttemptObjectKey(fileId, 3, "../other-owner", "preview.webp"))
      .toThrow("invalid private file output attempt identity");
  });
});
