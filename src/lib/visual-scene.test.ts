import { describe, expect, it, vi } from "vitest";
import {
  VISUAL_BLOCK_KINDS,
  VISUAL_CAPABILITIES,
  materializeCapability,
  mergeVisualScene,
  normalizeVisualScene,
} from "./visual-scene";

describe("visual scene contract", () => {
  it("exposes more than twenty distinct reusable visual modules", () => {
    expect(VISUAL_BLOCK_KINDS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(VISUAL_BLOCK_KINDS).size).toBe(VISUAL_BLOCK_KINDS.length);
    expect(VISUAL_CAPABILITIES.length).toBeGreaterThanOrEqual(20);
  });

  it("bounds payloads and rejects executable links", () => {
    const scene = normalizeVisualScene({
      title: "x".repeat(300),
      blocks: Array.from({ length: 30 }, (_, index) => ({
        id: `block-${index}`,
        kind: "link_grid",
        items: Array.from({ length: 90 }, (__, itemIndex) => ({
          label: `item-${itemIndex}`,
          url: itemIndex === 0 ? "javascript:alert(1)" : "https://example.com/path",
        })),
      })),
    });
    expect(scene.title).toHaveLength(160);
    expect(scene.blocks).toHaveLength(24);
    expect(scene.blocks[0].items).toHaveLength(80);
    expect(scene.blocks[0].items?.[0].url).toBeUndefined();
    expect(scene.blocks[0].items?.[1].url).toBe("https://example.com/path");
  });

  it("patches stable block ids without replacing unrelated work", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const initial = normalizeVisualScene({
      title: "Empire",
      blocks: [
        { id: "money", kind: "metrics", title: "Money", items: [{ label: "MRR", value: 1 }] },
        { id: "roadmap", kind: "timeline", title: "Roadmap", items: [{ label: "Ship" }] },
      ],
    });
    const updated = mergeVisualScene(initial, {
      blocks: [{ id: "money", kind: "metrics", title: "Revenue", items: [{ label: "MRR", value: 2 }] }],
      remove: ["roadmap"],
      focus_block_id: "money",
    });
    expect(updated.blocks).toHaveLength(1);
    expect(updated.blocks[0].title).toBe("Revenue");
    expect(updated.blocks[0].items?.[0].value).toBe(2);
    expect(updated.focusBlockId).toBe("money");
    expect(updated.updatedAt).toBe(1234);
    vi.restoreAllMocks();
  });

  it("preserves and bounds persistent draggable module geometry", () => {
    const scene = normalizeVisualScene({
      blocks: [{ id: "chart", kind: "line", grid: { x: -4, y: 8.4, w: 40, h: 99 } }],
    });
    expect(scene.blocks[0].grid).toEqual({ x: 0, y: 8, w: 12, h: 24 });
    const updated = mergeVisualScene(scene, {
      blocks: [{ id: "chart", kind: "line", title: "Updated live chart" }],
    });
    expect(updated.blocks[0].grid).toEqual({ x: 0, y: 8, w: 12, h: 24 });
  });

  it("materializes allowlisted live capability bindings without fake data", () => {
    const scene = materializeCapability(
      normalizeVisualScene({ title: "Morning command", capability: "executive_brief" }),
    );
    expect(scene.blocks.map((block) => block.source)).toEqual(["attention", "projects", "agents", "findings"]);
    expect(scene.blocks.every((block) => block.kind === "app" && !block.items)).toBe(true);
  });
});
