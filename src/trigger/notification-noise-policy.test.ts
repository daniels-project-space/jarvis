import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("automatic notification policy", () => {
  it("keeps routine stack health and morning summaries out of chat and push", () => {
    for (const file of ["stack-poller.ts", "briefing.ts"]) {
      const source = readFileSync(join(process.cwd(), "src/trigger", file), "utf8");
      expect(source).not.toContain("chatQueue:postAssistant");
      expect(source).not.toContain("sendPush(");
    }
  });
});
