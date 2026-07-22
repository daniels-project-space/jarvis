import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const jarvisSource = readFileSync(new URL("./JarvisUI.tsx", import.meta.url), "utf8");
const viewsSource = readFileSync(new URL("./Views.tsx", import.meta.url), "utf8");

describe("foreground surface caller contracts", () => {
  it("fails closed if voice election cannot establish a single speaker", () => {
    const start = jarvisSource.indexOf("async function ensureVoice");
    const end = jarvisSource.indexOf("\n  async function narrateText", start);
    const ensureVoice = jarvisSource.slice(start, end);

    expect(ensureVoice).toContain("return (await electVoice({ client: me.current })) !== false;");
    expect(ensureVoice).toMatch(/catch \{[\s\S]*return false;/);
  });

  it("uses complete panel identity for close suppression and resets routed file filters", () => {
    expect(jarvisSource.match(/panelIdentity\(panel\)/g)).toHaveLength(3);
    expect(viewsSource).toContain("const filter = creationLibraryFilter(value);");
    expect(viewsSource).toContain("}, [value]);");
  });
});
