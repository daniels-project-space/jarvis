import { describe, expect, it } from "vitest";
import {
  CODEX_DEVICE_AUTH_URI,
  parseCodexDevicePrompt,
} from "./codex-auth-enrollment";

describe("Codex device enrollment", () => {
  it("extracts only the fixed OpenAI verification URI and bounded one-time code", () => {
    expect(
      parseCodexDevicePrompt(
        [
          "Follow these steps to sign in with ChatGPT using device code authorization:",
          `\u001b[94m${CODEX_DEVICE_AUTH_URI}\u001b[0m`,
          "Enter this one-time code (expires in 15 minutes)",
          "\u001b[94mAB12-CDE34\u001b[0m",
        ].join("\n"),
        1_000,
      ),
    ).toEqual({
      verificationUri: CODEX_DEVICE_AUTH_URI,
      userCode: "AB12-CDE34",
      expiresAt: 901_000,
    });
  });

  it("rejects alternate origins, malformed codes, and partial output", () => {
    expect(
      parseCodexDevicePrompt(
        "https://example.test/codex/device\nAB12-CDE34",
        1_000,
      ),
    ).toBeNull();
    expect(
      parseCodexDevicePrompt(`${CODEX_DEVICE_AUTH_URI}\nnot-a-code`, 1_000),
    ).toBeNull();
    expect(parseCodexDevicePrompt("AB12-CDE34", 1_000)).toBeNull();
  });
});
