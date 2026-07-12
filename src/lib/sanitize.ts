// The live model occasionally writes tool syntax or raw tool JSON as TEXT
// instead of calling the function — then reads it aloud, and the garbage
// poisons mirrored history so the next session imitates it. These helpers
// recover the intended call and keep the junk out of history, chat and speech.

export type RecoveredCall = { name: string; args: any };

// Matches the observed hallucination shapes:
//   <function>show{"kind":"url","value":"…"}</function>
//   <function>timer{"minutes":2,"label":"Timer"}></function>
const FN_RE = /<function>?\s*(\w+)\s*(\{[\s\S]*?\})?\s*>?\s*<\/function>/gi;

export function extractFunctionCalls(text: string): RecoveredCall[] {
  const calls: RecoveredCall[] = [];
  for (const m of text.matchAll(FN_RE)) {
    let args: any = {};
    try {
      args = m[2] ? JSON.parse(m[2]) : {};
    } catch {
      continue; // unparseable args — don't guess
    }
    calls.push({ name: m[1], args });
  }
  return calls;
}

export function sanitizeAssistantText(text: string): string {
  let t = text;
  t = t.replace(FN_RE, " ");
  t = t.replace(/<function>[\s\S]*$/gi, " "); // unterminated tool syntax tail
  t = t.replace(/\{"kind"\s*:[\s\S]*$/g, " "); // raw widget JSON blob to end (before the bracket line, or it leaves "}]" residue)
  t = t.replace(/[\w".,:[\]{}\-]*"(?:days|hours|items)"\s*:\s*\[[\s\S]*$/g, " "); // JSON tails
  t = t.replace(/\[showed on screen:[\s\S]*?(\]|$)/gi, " "); // parroted history lines
  return t.replace(/\s{2,}/g, " ").trim();
}

// True when the row is pure tool-garbage a human should never see.
export function isToolGarbage(text: string): boolean {
  return /<function|\{"kind"\s*:|\[showed on screen:|"(?:days|hours|items)"\s*:\s*\[/i.test(text);
}
