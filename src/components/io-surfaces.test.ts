import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("reactive IO surfaces", () => {
  it("keeps one bounded command center subscription and no legacy fleet surface", () => {
    const jarvis = source("src/components/JarvisUI.tsx");
    expect(jarvis.match(/api\.commandCenter\.snapshot/g)).toHaveLength(1);
    expect(jarvis).not.toContain("api.jobs.active");
    expect(jarvis).not.toContain("api.jobs.list");
    expect(jarvis).not.toMatch(/api\.(?:health|reaper|cron)\./);

    const command = source("convex/commandCenter.ts");
    expect(command.match(/\.first\(\)/g)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(command).toContain('withIndex("by_thread_visibility_active_priority"');
    expect(command).toContain('withIndex("by_mission"');
  });

  it("mounts twenty live rows, eight embedded rows, and cursor history only in the open drawer", () => {
    const jarvis = source("src/components/JarvisUI.tsx");
    expect(jarvis).toContain("api.chatQueue.listMessages");
    expect(jarvis).toContain("api.chatQueue.listRecentMessages");
    expect(jarvis).toContain(".slice(-20)");
    expect(jarvis).toContain("drawerOpen && <ChatHistoryArchive key={thread} threadId={thread}");
    expect(jarvis).toContain("api.chatQueue.paginatedMessages");
    expect(jarvis).toContain("key={thread}");

    const chat = source("convex/chatQueue.ts");
    expect(chat).toContain(".take(20)");
    expect(chat).toContain(".take(8)");
    expect(chat).toContain("maximumRowsRead: HISTORY_PAGE_MAX");
  });

  it("uses the guest-safe attachment boundary for both live and paginated rows", () => {
    const jarvis = source("src/components/JarvisUI.tsx");
    expect(jarvis.match(/<GuestSafeAttachment/g)).toHaveLength(2);
    expect(jarvis).toContain(".filter((m) => m.text || (!guest && m.attachment) || m.status === \"streaming\")");
  });

  it("loads exact job detail lazily without a second fleet subscription", () => {
    const jarvis = source("src/components/JarvisUI.tsx");
    expect(jarvis.match(/api\.jobs\.detail/g)).toHaveLength(1);
    expect(jarvis).toContain('workDetailJobId ? { jobId: workDetailJobId as never } : "skip"');
    const work = source("src/components/CompactWorkBar.tsx");
    expect(work).toContain("data-fleet-detail-loading");
    expect(work).not.toContain("api.jobs.active");
  });
});
