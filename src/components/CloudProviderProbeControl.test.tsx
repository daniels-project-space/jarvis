import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudProviderProbeControl } from "./CloudProviderProbeControl";

describe("CloudProviderProbeControl", () => {
  it("renders an explicit bounded owner verification affordance", () => {
    const markup = renderToStaticMarkup(<CloudProviderProbeControl />);

    expect(markup).toContain("verify release");
    expect(markup).toContain("not attested for this release");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("provider-specific detail");
    expect(markup).not.toContain("user task");
  });
});
