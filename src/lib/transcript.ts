// Whisper occasionally returns the same complete utterance twice from one
// recording window. Remove only exact whole-utterance repetition; ordinary
// emphasis inside a sentence ("very, very good") is left alone.
export function cleanSpeechTranscript(input: string): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return "";

  const matches = [...text.matchAll(/[\p{L}\p{N}']+/gu)];
  const words = matches.map((match) => match[0].toLocaleLowerCase("en-GB"));
  for (let span = 2; span <= Math.floor(words.length / 2); span += 1) {
    if (words.length % span !== 0) continue;
    const repetitions = words.length / span;
    if (repetitions < 2) continue;
    const repeated = words.every((word, index) => word === words[index % span]);
    if (!repeated) continue;
    const secondStart = matches[span]?.index;
    if (secondStart == null) break;
    return text.slice(0, secondStart).trim().replace(/[\s,;:\-–—]+$/, "");
  }
  return text;
}
