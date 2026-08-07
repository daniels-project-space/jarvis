import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../convex/_generated/api", () => ({
  api: { files: { listForThread: { _name: "files:listForThread" } } },
}));
vi.mock("@/lib/secure-convex", () => ({ useJarvisQuery: () => [] }));

import { ChatFilePicker } from "./ChatFilePicker";

describe("in-chat attachment control", () => {
  it("renders one discoverable, accessible composer button backed by real file inputs", () => {
    const markup = renderToStaticMarkup(
      <ChatFilePicker
        threadId="main"
        selectedFileIds={[]}
        pendingFileIds={[]}
        onSelectionChange={vi.fn()}
        onPendingChange={vi.fn()}
        notice={null}
        onNotice={vi.fn()}
      />,
    );

    expect(markup).toContain('id="jarvis-attachment-trigger"');
    expect(markup).toContain('aria-label="Attach files, folders, or saved files"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup.match(/type="file"/g)).toHaveLength(2);
    expect(markup.match(/multiple=""/g)).toHaveLength(2);
    expect(markup).not.toContain("＋ file");
  });

  it("announces the number of selected and processing attachments", () => {
    const markup = renderToStaticMarkup(
      <ChatFilePicker
        threadId="main"
        selectedFileIds={["ready-file"]}
        pendingFileIds={["pending-file"]}
        onSelectionChange={vi.fn()}
        onPendingChange={vi.fn()}
        notice={null}
        onNotice={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Attachments: 2 selected or processing"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Jarvis is indexing 1 file");
  });
});
