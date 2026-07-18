const SCAVENGER = /\b(scavenger hunt|treasure hunt|clue trail|clue hunt)\b/i;
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
  if (VISUAL_STRUCTURE.test(text)) {
    return (
      "VISUAL INITIATIVE FOR THIS TURN: the topic has structure that is clearer on screen. Proactively create or update " +
      "the smallest useful visual_scene, mind_map, chart or board while answering; reuse the open creation when it is the same topic."
    );
  }
  return "";
}
