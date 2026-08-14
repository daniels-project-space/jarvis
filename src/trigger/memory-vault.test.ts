import { describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => ({
  definitions: new Map<string, { id: string; cron?: string; maxDuration?: number }>(),
}));

vi.mock("@trigger.dev/sdk/v3", () => ({
  schedules: {
    task: (definition: { id: string; cron?: string; maxDuration?: number }) => {
      trigger.definitions.set(definition.id, definition);
      return definition;
    },
  },
}));

import { MEMORY_VAULT_CRON, obsidianMemoryFolderForKind } from "./memory-vault";

describe("Obsidian memory-vault schedule", () => {
  it("consolidates the durable mirror every six hours", () => {
    expect(MEMORY_VAULT_CRON).toBe("17 */6 * * *");
    expect(trigger.definitions.get("jarvis-memory-vault")).toMatchObject({
      cron: MEMORY_VAULT_CRON,
      maxDuration: 180,
    });
  });

  it("keeps automatically extracted tasks in the durable Obsidian mirror", () => {
    expect(obsidianMemoryFolderForKind("task")).toBe("80-facts");
    expect(obsidianMemoryFolderForKind("decision")).toBe("30-decisions");
    expect(obsidianMemoryFolderForKind("project")).toBe("20-projects");
    expect(obsidianMemoryFolderForKind("untrusted-kind")).toBeNull();
  });
});
