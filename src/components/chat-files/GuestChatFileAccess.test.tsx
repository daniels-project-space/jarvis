import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GuestChatFileAccess } from "./GuestChatFileAccess";

describe("guest attachment access control", () => {
  it.each([
    [false, "standalone", "Private uploads need an enrolled owner session in this browser."],
    [true, "embedded", "Connect the signed-in Jarvis session before uploading files in this app."],
  ])("keeps a discoverable %s guest control without exposing private inputs", (embedded, surface, description) => {
    const markup = renderToStaticMarkup(
      <GuestChatFileAccess embedded={embedded} onRequestOwnerAccess={vi.fn()} />,
    );

    expect(markup).toContain('id="jarvis-attachment-trigger"');
    expect(markup).toContain('aria-label="Attach files — connect owner tools"');
    expect(markup).toContain(`data-jarvis-attachment-surface="${surface}"`);
    expect(markup).toContain(description);
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("Saved files");
  });
});
