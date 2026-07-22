import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuestSafeAttachment } from "./GuestSafeAttachment";

describe("GuestSafeAttachment", () => {
  const legacyAttachment = { type: "image", value: "r2://private-frame", title: "legacy card" };

  it("renders a guest text row rather than its legacy card", () => {
    const markup = renderToStaticMarkup(
      <GuestSafeAttachment
        guest
        attachment={legacyAttachment}
        renderAttachment={(attachment) => <article data-media-card>{attachment.title}</article>}
      >
        <span data-message-text>visible guest text</span>
      </GuestSafeAttachment>,
    );

    expect(markup).toContain("visible guest text");
    expect(markup).not.toContain("legacy card");
    expect(markup).not.toContain("data-media-card");
  });

  it("renders the attachment for an owner", () => {
    const markup = renderToStaticMarkup(
      <GuestSafeAttachment
        guest={false}
        attachment={legacyAttachment}
        renderAttachment={(attachment) => <article data-media-card>{attachment.title}</article>}
      >
        <span data-message-text>visible owner text</span>
      </GuestSafeAttachment>,
    );

    expect(markup).toContain("legacy card");
    expect(markup).toContain("data-media-card");
    expect(markup).not.toContain("visible owner text");
  });
});
