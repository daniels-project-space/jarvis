import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompactWorkItem } from "../lib/active-work";
import { CompactWorkBar } from "./CompactWorkBar";

const work: CompactWorkItem = {
  id: "job-1",
  label: "Paul · current repair",
  status: "running",
  stage: "testing",
  percent: 64,
};

describe("CompactWorkBar", () => {
  it("renders nothing for an empty result", () => {
    expect(renderToStaticMarkup(<CompactWorkBar work={null} />)).toBe("");
  });

  it("renders exactly one minimal compact item for active work", () => {
    const markup = renderToStaticMarkup(<CompactWorkBar work={work} />);

    expect(markup.match(/data-compact-work-bar/g)).toHaveLength(1);
    expect(markup).toContain('data-work-id="job-1"');
    expect(markup).toContain("Paul · current repair");
    expect(markup).toContain("testing");
    expect(markup).toContain("64%");
    expect(markup).not.toContain("live work terminal");
    expect(markup).not.toContain("next ·");
  });

  it("does not render beside an owning fleet or detail overlay", () => {
    expect(renderToStaticMarkup(<CompactWorkBar work={work} hidden />)).toBe("");
  });
});
