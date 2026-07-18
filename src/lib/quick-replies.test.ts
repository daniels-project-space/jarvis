import { describe, expect, it } from "vitest";
import { instantSocialReply } from "./quick-replies";

describe("instantSocialReply", () => {
  it("answers a greeting without a model round trip", () => {
    expect(instantSocialReply("Hi")).toContain("Right here");
    expect(instantSocialReply("Hello Jarvis")).toContain("Right here");
  });

  it("does not intercept a request that needs intelligence", () => {
    expect(instantSocialReply("Hi, audit the returns hub")).toBeNull();
  });
});
