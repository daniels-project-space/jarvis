import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Vercel live-provider probe source contract", () => {
  it("uses the same finite owner-scoped page traversal as create-time admission", () => {
    const source = readFileSync(new URL("./probe-cloud-workspace-provider.ts", import.meta.url), "utf8");
    expect(source).toContain("namePrefix: VERCEL_NAME_PREFIX, tags: { owner: \"jarvis\" }");
    expect(source).toContain("limit: VERCEL_HISTORY_PAGE_LIMIT");
    expect(source).toContain("for await (const page of listed.pages())");
    expect(source).toContain("pages > VERCEL_HISTORY_PAGE_CEILING || total > VERCEL_HISTORY_TOTAL_CEILING");
    expect(source).toContain('["pending", "running", "snapshotting", "stopping"]');
    expect(source).not.toContain("for await (const item of listed)");
  });
});
