import { describe, expect, it } from "vitest";
import { hasExpectedMediaSignature, mediaFilenameExtension, transcribableMediaKind } from "./media-types";

describe("private media container admission", () => {
  it("accepts only the narrow supported audio/video MIME set", () => {
    expect(transcribableMediaKind("audio/wav")).toBe("audio");
    expect(transcribableMediaKind("video/mp4")).toBe("video");
    expect(transcribableMediaKind("video/x-msvideo")).toBeNull();
    expect(mediaFilenameExtension("video/quicktime")).toBe("mov");
  });

  it("requires a matching container signature before private bytes leave ingestion", () => {
    const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f3261766331", "hex");
    const wav = Buffer.from("524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000", "hex");

    expect(hasExpectedMediaSignature("video/mp4", mp4)).toBe(true);
    expect(hasExpectedMediaSignature("audio/wav", wav)).toBe(true);
    expect(hasExpectedMediaSignature("video/mp4", new TextEncoder().encode("not media"))).toBe(false);
    expect(hasExpectedMediaSignature("audio/wav", mp4)).toBe(false);
  });
});
