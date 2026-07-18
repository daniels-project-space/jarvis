import { describe, expect, it } from "vitest";
import { parseTerminalOutput } from "./terminal-output";

describe("semantic terminal output", () => {
  it("uses a neutral default and distinct command, success, warning, and error tones", () => {
    const lines = parseTerminalOutput(
      [
        "Inspecting the current implementation",
        "▸ Running npm test",
        "✓ verification passed",
        "warning: retrying provider",
        "! command failed",
      ].join("\n"),
      "starting up…",
    );

    expect(lines.map((line) => line.tone)).toEqual(["neutral", "command", "success", "warning", "error"]);
  });

  it("honours real ANSI colour spans while removing control sequences", () => {
    const [line] = parseTerminalOutput("\u001b[35mPaul\u001b[0m reviewed \u001b[32mready\u001b[0m", "starting");

    expect(line.text).toBe("Paul reviewed ready");
    expect(line.spans).toEqual([
      { text: "Paul", tone: "accent" },
      { text: " reviewed ", tone: "success" },
      { text: "ready", tone: "success" },
    ]);
  });

  it("highlights paths and numeric values without tinting the whole narrative", () => {
    const [line] = parseTerminalOutput("Updated /src/app.ts at 82% confidence", "starting");

    expect(line.tone).toBe("neutral");
    expect(line.spans).toEqual(expect.arrayContaining([
      { text: "/src/app.ts", tone: "info" },
      { text: "82%", tone: "value" },
    ]));
  });

  it("keeps truthful line numbers when the terminal trims old output", () => {
    const lines = parseTerminalOutput(
      Array.from({ length: 165 }, (_, index) => `event ${index + 1}`).join("\n"),
      "starting",
    );

    expect(lines).toHaveLength(160);
    expect(lines[0].number).toBe(6);
    expect(lines.at(-1)?.number).toBe(165);
  });
});
