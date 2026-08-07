import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { assertPrivateBucketName, privateR2ConfigurationCode } from "./private-r2";

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
});
