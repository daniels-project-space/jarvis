const SCAVENGER = /\b(scavenger hunt|treasure hunt|clue trail|clue hunt)\b/i;
const CREATIVE_WORLD =
  /\b(character|protagonist|antagonist|scene|plot|story beat|storyboard|screenplay|script|film|worldbuilding|moodboard)\b/i;
const VISUAL_STRUCTURE =
  /\b(choices?|options?|alternatives?|compare|comparison|pros? and cons?|brainstorm|mind ?map|timeline|roadmap|workflow|architecture|journey|route|itinerary|schedule|plan|stages?|relationships?|decision matrix|storyboard|moodboard|layout)\b/i;

export function visualInitiativeDirective(userText: string): string {
  const text = userText.trim();
  if (!text) return "";
  if (SCAVENGER.test(text)) {
    return (
      "VISUAL INITIATIVE FOR THIS TURN: this is scavenger-hunt planning. Open or update a real board now; " +
      "use the scavenger template for a new board, put Daniel's confirmed choices/clues into their proper zones, " +
      "and keep the board's stable creation id as the conversation develops. Do not invent unconfirmed details."
    );
  }
  if (CREATIVE_WORLD.test(text)) {
    return (
      "VISUAL INITIATIVE FOR THIS TURN: this is creative worldbuilding. Create or update the same film board, then use " +
      "board/capture with Daniel's exact words in source_text. Extract the thought into EVERY category it establishes " +
      "(character, location, plot, timeline, visual, relationship, theme, object, question), link the stable ids, and mark " +
      "anything merely implied as inferred. One sentence may produce several nodes; never flatten it into one note or invent facts."
    );
  }
  const routedVisual = rankCapabilities(text, { limit: 4 }).candidates.find(
    (candidate) => candidate.visual && candidate.tool !== "show" && candidate.tool !== "visual_scene",
  );
  if (routedVisual) {
    return (
      `SPECIALISED CAPABILITY FOR THIS TURN: route with jarvis_get_tools(intent=<the current request>) and use ${routedVisual.tool}. ` +
      "Execute that real data/interactive capability before replying; do not substitute a decorative visual_scene, generic show card, or prose-only refusal."
    );
  }
  if (VISUAL_STRUCTURE.test(text)) {
    return (
      "VISUAL INITIATIVE FOR THIS TURN: the topic has structure that is clearer on screen. Proactively create or update " +
      "the smallest useful visual_scene, mind_map, chart or board while answering; reuse the open creation when it is the same topic."
    );
  }
  return "";
}
import { rankCapabilities } from "./capability-router";
