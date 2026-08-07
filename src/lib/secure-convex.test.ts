import { describe, expect, it } from "vitest";
import { makeFunctionReference } from "convex/server";
import { isGuestQueryAllowed } from "./secure-convex";

describe("guest Convex query admission", () => {
  it("uses Convex's public function-name API for generated references", () => {
    expect(isGuestQueryAllowed(makeFunctionReference("chatQueue:listMessages"))).toBe(true);
    expect(isGuestQueryAllowed(makeFunctionReference("chatQueue:turnStatus"))).toBe(true);
    expect(isGuestQueryAllowed(makeFunctionReference("commandCenter:snapshot"))).toBe(false);
  });
});
