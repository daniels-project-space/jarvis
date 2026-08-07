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
    expect(jarvis.match(/<GuestChatFileAccess/g)).toHaveLength(3);
    expect(jarvis).toContain('<GuestChatFileAccess embedded onRequestOwnerAccess={() => void connectEmbeddedOwner()} />');
    expect(jarvis).toContain('<GuestChatFileAccess embedded={false} onRequestOwnerAccess={() => window.location.reload()} />');
    expect(jarvis).toContain('{chatMode === "full" && (guest ? (');
    expect(jarvis).toContain('{guest && chatMode === "bar" ? (');
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

  it("keeps the public attachment affordance actionable without mounting private inputs", () => {
    const gate = source("src/components/chat-files/GuestChatFileAccess.tsx");

    expect(gate).toContain('aria-label="Attach files — connect owner tools"');
    expect(gate).toContain('data-jarvis-attachment-access="guest-locked"');
    expect(gate).toContain('"connect owner tools"');
    expect(gate).toContain('"check owner access"');
    expect(gate).toContain("Guest sessions never receive file inputs");
    expect(gate).not.toContain('type="file"');
    expect(gate).not.toContain("ChatFileLibraryDropdown");
  });
});
