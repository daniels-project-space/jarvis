import { describe, expect, it } from "vitest";
import { canRenderPersistentAttachment } from "./guest-attachment";

describe("guest persistent attachment boundary", () => {
  const legacyAttachment = { type: "image", value: "r2://private-frame", title: "legacy card" };

  it("never renders a legacy attachment for a guest, even beside visible text", () => {
    expect(canRenderPersistentAttachment(true, legacyAttachment)).toBe(false);
  });

  it("keeps owner cards available and ignores absent attachments for every actor", () => {
    expect(canRenderPersistentAttachment(false, legacyAttachment)).toBe(true);
    expect(canRenderPersistentAttachment(false, undefined)).toBe(false);
    expect(canRenderPersistentAttachment(true, null)).toBe(false);
  });
});
