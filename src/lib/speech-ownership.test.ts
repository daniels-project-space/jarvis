import { describe, expect, it } from "vitest";
import { finalSpeechSuffix, retainCaption, type SpeechCaption } from "./speech-ownership";

describe("streamed speech ownership", () => {
  it("assigns an exact streamed prefix and only the final suffix to one turn", () => {
    const final = "I have the first answer. The second answer is now ready.";
    const prefix = "I have the first answer.";

    expect(finalSpeechSuffix(final, prefix)).toBe("The second answer is now ready.");
    expect(`${prefix} ${finalSpeechSuffix(final, prefix)}`).toBe(final);
  });

  it("lets final delivery own the full answer when its displayed text changed", () => {
    expect(finalSpeechSuffix("A safe final answer.", "An unsafe streamed prefix.")).toBe("A safe final answer.");
  });

  it("retains a stable Jarvis caption through stream, speech and final delivery", () => {
    let caption: SpeechCaption = { who: "jarvis", text: "I have the first", phase: "streaming" };
    const node = caption;
    caption = retainCaption(caption, { who: "jarvis", text: "I have the first answer.", phase: "speaking" });
    expect(caption).toMatchObject({ who: "jarvis", text: "I have the first answer.", phase: "speaking", exiting: false });
    // The state remains the same caption identity (Jarvis), so the component
    // keeps its one DOM surface instead of replacing it at finalisation.
    expect(caption?.who).toBe(node.who);
    caption = retainCaption(caption, { who: "jarvis", text: "I have the first answer. The final suffix.", phase: "ready" });
    expect(caption).toMatchObject({ phase: "ready", exiting: false });
  });
});
