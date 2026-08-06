import { describe, expect, it } from "vitest";
import { advanceFinalDelivery, type FinalDeliveryCursor } from "./final-delivery";

const empty: FinalDeliveryCursor = { threadId: "", initialized: false, lastMessageId: null };

describe("advanceFinalDelivery", () => {
  it("silences preloaded history but delivers the first new reply on an empty thread", () => {
    const hydrated = advanceFinalDelivery(empty, { threadId: "main", hydrated: true, latest: null });
    expect(hydrated.deliver).toBe(false);
    expect(advanceFinalDelivery(hydrated.cursor, {
      threadId: "main",
      hydrated: true,
      latest: { id: "first", parentMessageId: "user-1" },
      activeParentMessageId: "user-1",
    }).deliver).toBe(true);
  });

  it("does not narrate existing history during initial hydration", () => {
    const result = advanceFinalDelivery(empty, {
      threadId: "main",
      hydrated: true,
      latest: { id: "old", parentMessageId: "old-user" },
    });
    expect(result).toEqual({
      cursor: { threadId: "main", initialized: true, lastMessageId: "old" },
      deliver: false,
    });
  });

  it("delivers an active reply that lands in the first hydrated snapshot exactly once", () => {
    const first = advanceFinalDelivery(empty, {
      threadId: "main",
      hydrated: true,
      latest: { id: "reply", parentMessageId: "active-user" },
      activeParentMessageId: "active-user",
    });
    expect(first.deliver).toBe(true);
    expect(advanceFinalDelivery(first.cursor, {
      threadId: "main",
      hydrated: true,
      latest: { id: "reply", parentMessageId: "active-user" },
      activeParentMessageId: "active-user",
    }).deliver).toBe(false);
  });
});
