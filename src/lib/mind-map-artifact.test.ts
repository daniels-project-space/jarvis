import { describe, expect, it } from "vitest";
import { renderMindMapSvg } from "./mind-map-artifact";

describe("renderMindMapSvg", () => {
  it("renders a self-contained mind-map image without preserving executable markup or remote URLs", () => {
    const svg = renderMindMapSvg({
      title: "<script>title</script>",
      nodes: [
        { id: "root", label: "Plan <script>alert(1)</script>", detail: "https://untrusted.example/image.png", color: "blue" },
        { id: "next", label: "Next stop", color: "amber" },
      ],
      edges: [{ from: "root", to: "next" }, { from: "root", to: "missing" }],
    });

    expect(svg).toContain("&lt;script&gt;title&lt;/script&gt;");
    expect(svg).toContain("Plan &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<image");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.match(/<line /g)).toHaveLength(1);
  });
});
