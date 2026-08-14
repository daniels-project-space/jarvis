import { describe, expect, it } from "vitest";
import { shouldDismissEmbeddedHandoff } from "./overlay-handoff";

describe("shouldDismissEmbeddedHandoff", () => {
  it("closes only an accepted embedded handoff", () => {
    expect(shouldDismissEmbeddedHandoff({ embedded: true, awaitingApproval: false })).toBe(true);
    expect(shouldDismissEmbeddedHandoff({ embedded: false, awaitingApproval: false })).toBe(false);
    expect(shouldDismissEmbeddedHandoff({ embedded: true, awaitingApproval: true })).toBe(false);
  });
});
