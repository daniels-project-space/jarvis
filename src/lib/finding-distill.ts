export type FindingForDistill = {
  source?: string | null;
  spoken?: string | null;
  detail?: string | null;
};

function cleanBullet(value: string): string {
  return value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\[JARVIS verify:[^\]]+\]\s*/gi, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function candidateBullets(value: string): string[] {
  const lines = value
    .split(/\n+/)
    .map(cleanBullet)
    .filter((line) => line.length >= 12 && !/^(delivery|definition of done|agent evidence|task):?$/i.test(line));
  if (lines.length >= 3) return lines;
  return value
    .split(/(?<=[.!?])\s+/)
    .map(cleanBullet)
    .filter((line) => line.length >= 12);
}

export function distillFinding(finding: FindingForDistill): { important: boolean; bullets: string[] } {
  const source = String(finding.source ?? "");
  const spoken = cleanBullet(String(finding.spoken ?? ""));
  const detail = String(finding.detail ?? "");
  const combined = `${source}\n${spoken}\n${detail}`;
  const needsDaniel =
    /\b(needs? (?:daniel|your) (?:decision|approval|input)|waiting (?:for|on) (?:daniel|you)|customer|rental|booking|bank|payment|invoice|revenue|money|blocked|failed|error|risk)\b|£|\$\d|https?:\/\//i.test(combined);
  const routineInternal =
    /\b(self[- ]repair|internal plumbing|validator|schema migration|tooling fix|dependency update|lint|typecheck|test run|ci configuration|build pipeline)\b/i.test(combined) &&
    !needsDaniel;

  const candidates = [spoken, ...candidateBullets(detail)]
    .filter(Boolean)
    .filter((line, index, all) => all.findIndex((other) => other.toLowerCase() === line.toLowerCase()) === index)
    .sort((left, right) => {
      const concrete = (value: string) => (/[\d£$%]|https?:\/\//.test(value) ? 2 : 0) + (/\b(done|ready|fixed|found|recommend|blocked|failed)\b/i.test(value) ? 1 : 0);
      return concrete(right) - concrete(left);
    })
    .slice(0, 5);

  return {
    important: !routineInternal,
    bullets: candidates.length ? candidates : ["Background work finished; open the full report for details."],
  };
}
