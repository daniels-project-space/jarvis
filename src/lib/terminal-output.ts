export type TerminalTone =
  | "neutral"
  | "muted"
  | "command"
  | "info"
  | "accent"
  | "value"
  | "success"
  | "warning"
  | "error";

export type TerminalSpan = {
  text: string;
  tone: TerminalTone;
};

export type TerminalLine = {
  id: string;
  number: number;
  text: string;
  tone: TerminalTone;
  spans: TerminalSpan[];
};

const ANSI_SGR = /\u001b\[([0-9;]*)m/g;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripTerminalControls(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/\r/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "");
}

function lineTone(value: string): TerminalTone {
  const text = value.trim();
  if (!text) return "muted";
  if (/^(?:!|✕|✖|×)\s|\b(?:error|failed|failure|fatal|exception|denied|timed out|timeout)\b/i.test(text)) return "error";
  if (/^(?:warn(?:ing)?|\?)\b|\b(?:warning|caution|retrying|blocked|degraded)\b/i.test(text)) return "warning";
  if (/^(?:✓|✔|√)\s|\b(?:done|completed?|success|succeeded|passed|verified|ready)\b/i.test(text)) return "success";
  if (/^(?:▸|›|>|\$)\s|^\s*(?:running|using|executing|command)\b|\s\$\s/i.test(text)) return "command";
  if (/\b(?:session started|connected|checkpoint|branch|reviewing|model|stage|heartbeat)\b/i.test(text)) return "info";
  if (/^#{1,6}\s|^\*\*|^\s*(?:analysis|reasoning|thought):/i.test(text)) return "accent";
  return "neutral";
}

function ansiTone(codes: number[], fallback: TerminalTone): TerminalTone {
  let tone = fallback;
  for (const code of codes) {
    if (code === 0 || code === 39) tone = fallback;
    else if (code === 31 || code === 91) tone = "error";
    else if (code === 32 || code === 92) tone = "success";
    else if (code === 33 || code === 93) tone = "warning";
    else if (code === 34 || code === 94) tone = "info";
    else if (code === 35 || code === 95) tone = "accent";
    else if (code === 36 || code === 96) tone = "command";
    else if (code === 37 || code === 97) tone = "neutral";
    else if (code === 90) tone = "muted";
  }
  return tone;
}

const SEMANTIC_TOKEN =
  /(https?:\/\/[^\s]+|(?:\.{0,2}\/|\/)[A-Za-z0-9_@.+-][A-Za-z0-9_@./+-]*|`[^`]+`|"[^"\n]+"|'[^'\n]+'|\b\d+(?:\.\d+)?%?(?!\w)|\b(?:error|failed|failure|fatal|exception|denied|timeout)\b|\b(?:warn(?:ing)?|blocked|degraded|retrying)\b|\b(?:done|complete(?:d)?|success|succeeded|passed|verified|ready)\b)/gi;

function tokenTone(token: string, fallback: TerminalTone): TerminalTone {
  if (/^https?:\/\//i.test(token) || /^(?:\.{0,2}\/|\/)/.test(token)) return "info";
  if (/^`|^["']/.test(token)) return "accent";
  if (/^\d/.test(token)) return "value";
  if (/^(?:error|failed|failure|fatal|exception|denied|timeout)$/i.test(token)) return "error";
  if (/^(?:warn(?:ing)?|blocked|degraded|retrying)$/i.test(token)) return "warning";
  if (/^(?:done|complete(?:d)?|success|succeeded|passed|verified|ready)$/i.test(token)) return "success";
  return fallback;
}

function semanticSpans(value: string, fallback: TerminalTone): TerminalSpan[] {
  const spans: TerminalSpan[] = [];
  let cursor = 0;
  for (const match of value.matchAll(SEMANTIC_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) spans.push({ text: value.slice(cursor, index), tone: fallback });
    spans.push({ text: match[0], tone: tokenTone(match[0], fallback) });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) spans.push({ text: value.slice(cursor), tone: fallback });
  return spans.length ? spans : [{ text: value, tone: fallback }];
}

function ansiSpans(raw: string, fallback: TerminalTone): TerminalSpan[] | null {
  ANSI_SGR.lastIndex = 0;
  if (!ANSI_SGR.test(raw)) return null;
  ANSI_SGR.lastIndex = 0;
  const spans: TerminalSpan[] = [];
  let cursor = 0;
  let tone = fallback;
  let match: RegExpExecArray | null;
  while ((match = ANSI_SGR.exec(raw))) {
    const before = stripTerminalControls(raw.slice(cursor, match.index));
    if (before) spans.push({ text: before, tone });
    const codes = (match[1] || "0").split(";").map((value) => Number(value) || 0);
    tone = ansiTone(codes, fallback);
    cursor = match.index + match[0].length;
  }
  const tail = stripTerminalControls(raw.slice(cursor));
  if (tail) spans.push({ text: tail, tone });
  return spans;
}

export function parseTerminalOutput(value: string | undefined, fallback: string): TerminalLine[] {
  const source = value?.trimEnd() || `› ${fallback}`;
  const allRows = source.split("\n");
  const offset = Math.max(0, allRows.length - 160);
  const rows = allRows.slice(offset);
  return rows.map((raw, index) => {
    const text = stripTerminalControls(raw);
    const tone = lineTone(text);
    const number = offset + index + 1;
    return {
      id: `${number}:${text.slice(0, 48)}`,
      number,
      text,
      tone,
      spans: ansiSpans(raw, tone) ?? semanticSpans(text, tone),
    };
  });
}
