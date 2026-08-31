import { describe, expect, it } from "vitest";
import { isActionablePush } from "./push-send";

describe("push interruption policy", () => {
  it("drops uncategorized automatic output", () => {
    expect(isActionablePush({})).toBe(false);
  });

  it.each(["price_hunt", "errand", "work", "reminder", "incident"] as const)(
    "permits the explicit %s category to reach its preference gate",
    (category) => {
      expect(isActionablePush({ category })).toBe(true);
    },
  );
});
