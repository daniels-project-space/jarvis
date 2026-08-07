import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Jarvis attachment composer contract", () => {
  it("keeps pending upload intent above picker mount state and gates every send surface", () => {
    const jarvis = source("src/components/JarvisUI.tsx");

    expect(jarvis).toContain("const [pendingFileIds, setPendingFileIds]");
    expect(jarvis.match(/<ChatFilePendingMonitor/g)).toHaveLength(2);
    expect(jarvis).toContain("if (!guest && pendingFileIds.length)");
    expect(jarvis.match(/disabled=\{sending \|\| Boolean\(pendingFileIds\.length\)/g)).toHaveLength(3);
    expect(jarvis.match(/pendingFileIds=\{pendingFileIds\}/g)).toHaveLength(4);
    expect(jarvis).toContain('<div className="flex gap-2">\n            {!guest && (\n              <ChatFilePicker');
    expect(jarvis).toContain('<div className="flex min-w-0 max-w-full items-stretch gap-1.5 sm:gap-2">\n            {!guest && chatMode === "full" && (\n              <ChatFilePicker');
  });

  it("uses bounded upload transport and exposes explicit cancellation", () => {
    const uploader = source("src/lib/chat-file-upload.ts");
    const picker = source("src/components/chat-files/ChatFilePicker.tsx");

    expect(uploader).toContain("viewerFetchWithTimeout");
    expect(uploader).toContain("CHAT_FILE_LIMITS.clientUploadTimeoutMs");
    expect(uploader).not.toMatch(/\bviewerFetch\(/);
    expect(picker).toContain("uploadAbortRef.current?.abort");
    expect(picker).toContain("Sending waits so they stay with this message.");
    expect(picker).toContain("Attach files, folders, or saved files");
    expect(picker).toContain("Files & images");
    expect(picker).toContain("Saved files");
    expect(picker).toContain('role="progressbar"');
  });
});
