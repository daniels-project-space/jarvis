import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const viewsSource = readFileSync(new URL("./Views.tsx", import.meta.url), "utf8");

describe("Saved Work responsive library contract", () => {
  it("gives narrow screens a usable search, scroll-safe filters, and non-colliding cards", () => {
    const creations = viewsSource.slice(
      viewsSource.indexOf("export function CreationsView"),
      viewsSource.indexOf("export function CreationsView") + 12_000,
    );

    expect(creations).toContain("grid grid-cols-[minmax(0,1fr)_auto]");
    expect(creations).toContain("min-w-0 w-full flex-1");
    expect(creations).toContain("[scrollbar-width:none] [&::-webkit-scrollbar]:hidden");
    expect(creations).toContain("grid grid-cols-1 gap-2 sm:grid-cols-2");
    expect(creations).toContain("line-clamp-2 min-h-8 break-words");
    expect(creations).toContain("flex flex-wrap items-center gap-x-3 gap-y-1.5");
  });
});
