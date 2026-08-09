import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TOOL_DEFS } from "./tools";
import {
  SUBSCRIPTION_TOOL_NAMES,
  TOOL_BELT_NAMES,
  TOOL_BELTS,
  isToolBeltName,
} from "./tool-belts";

describe("tool belt registry", () => {
  const definedNames = new Set(TOOL_DEFS.map((tool) => tool.name));

  it("derives unique belt names from the actual registry", () => {
    expect(TOOL_BELT_NAMES).toEqual(Object.keys(TOOL_BELTS));
    expect(new Set(TOOL_BELT_NAMES).size).toBe(TOOL_BELT_NAMES.length);
    expect(TOOL_BELT_NAMES.every(isToolBeltName)).toBe(true);
  });

  it("only references defined tools and gives every definition a discoverable belt", () => {
    const beltReferences = TOOL_BELT_NAMES.flatMap((belt) => [...TOOL_BELTS[belt]]);
    expect([...new Set(beltReferences)].filter((name) => !definedNames.has(name))).toEqual([]);
    expect([...definedNames].filter((name) => !beltReferences.includes(name))).toEqual([]);
  });

  it("makes every subscription-exposed definition discoverable", () => {
    const discoverable = new Set(
      TOOL_BELT_NAMES.flatMap((belt) => [...TOOL_BELTS[belt]])
        .filter((name) => SUBSCRIPTION_TOOL_NAMES.has(name)),
    );
    expect([...SUBSCRIPTION_TOOL_NAMES].filter((name) => !definedNames.has(name))).toEqual([]);
    expect([...SUBSCRIPTION_TOOL_NAMES].filter((name) => !discoverable.has(name))).toEqual([]);
  });

  it("exposes the deterministic day planner without restoring metered deliberation", () => {
    expect(SUBSCRIPTION_TOOL_NAMES.has("plan_my_day")).toBe(true);
    expect(SUBSCRIPTION_TOOL_NAMES.has("deliberate")).toBe(false);
    expect(SUBSCRIPTION_TOOL_NAMES.has("work_control")).toBe(false);
  });
});
