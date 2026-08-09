import {
  sanitizeSpeculativeResearchSources,
  type SpeculativeResearchSource,
} from "./speculative-research";

export type ResearchLaneId = "direct" | "primary" | "independent";

export type ResearchLane = Readonly<{
  id: ResearchLaneId;
  query: string;
}>;

export type ResearchEvidenceSource = Readonly<{
  title: string;
  url: string;
  snippet: string;
  hostname: string;
  lanes: readonly ResearchLaneId[];
  score: number;
}>;

const MAX_QUERY_CHARS = 240;
const MAX_EVIDENCE_SOURCES = 8;

function cleanQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

function laneQuery(base: string, suffix: string): string {
  return cleanQuery(`${base} ${suffix}`);
}

/**
 * A bounded parallel search plan: direct answers, primary documentation, and
 * an independent limitation/check lane.  It intentionally avoids model-based
 * query expansion so preview work remains cancellable, auditable, and cheap.
 */
export function buildResearchLanes(question: string, suppliedQueries?: unknown): readonly ResearchLane[] {
  const base = cleanQuery(question);
  if (!base) return [];
  const suppliedQueryList: string[] = Array.isArray(suppliedQueries)
    ? suppliedQueries.map((value: unknown) => cleanQuery(String(value))).filter(Boolean)
    : [];
  const candidates: string[] = suppliedQueryList.length
    ? suppliedQueryList.slice(0, 3)
    : [
      base,
      laneQuery(base, "official documentation primary source"),
      laneQuery(base, "independent analysis limitations"),
    ];
  const ids: ResearchLaneId[] = ["direct", "primary", "independent"];
  const seen = new Set<string>();
  return candidates.flatMap((query, index) => {
    const key = query.toLocaleLowerCase("en-US");
    if (!query || seen.has(key)) return [];
    seen.add(key);
    return [{ id: ids[index] ?? "independent", query }];
  });
}

function hostname(url: string): string {
  try { return new URL(url).hostname.toLocaleLowerCase("en-US").replace(/^www\./, ""); } catch { return ""; }
}

function sourceScore(source: SpeculativeResearchSource, lane: ResearchLaneId): number {
  const host = hostname(source.url);
  let score = lane === "primary" ? 60 : lane === "direct" ? 45 : 40;
  if (/(?:^|\.)(?:gov|mil)$/i.test(host) || host.endsWith(".gov") || host.endsWith(".edu")) score += 35;
  if (host.startsWith("docs.") || /\/(?:docs?|documentation)\b/i.test(source.url)) score += 20;
  if (/\b(?:official|documentation|reference|release notes|technical report)\b/i.test(`${source.title} ${source.snippet}`)) score += 10;
  if (/(?:reddit\.com|news\.ycombinator\.com|stackoverflow\.com|forum)/i.test(host)) score -= 8;
  return score + Math.min(12, Math.floor(source.snippet.length / 30));
}

type Candidate = ResearchEvidenceSource & { lane: ResearchLaneId };

/** Ranks snippets without treating a search answer box as evidence. */
export function rankResearchSources(input: readonly { lane: ResearchLane; results: unknown }[]): readonly ResearchEvidenceSource[] {
  const byUrl = new Map<string, Candidate>();
  for (const result of input) {
    for (const source of sanitizeSpeculativeResearchSources(result.results)) {
      const existing = byUrl.get(source.url);
      const score = sourceScore(source, result.lane.id);
      if (existing) {
        const lanes = [...new Set([...existing.lanes, result.lane.id])];
        byUrl.set(source.url, { ...existing, lanes, score: Math.max(existing.score, score) });
        continue;
      }
      byUrl.set(source.url, {
        ...source,
        hostname: hostname(source.url),
        lanes: [result.lane.id],
        lane: result.lane.id,
        score,
      });
    }
  }
  const sorted = [...byUrl.values()].sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
  const output: Candidate[] = [];
  const usedHosts = new Set<string>();
  for (const candidate of sorted) {
    if (output.length >= MAX_EVIDENCE_SOURCES) break;
    if (candidate.hostname && usedHosts.has(candidate.hostname)) continue;
    output.push(candidate);
    if (candidate.hostname) usedHosts.add(candidate.hostname);
  }
  for (const candidate of sorted) {
    if (output.length >= MAX_EVIDENCE_SOURCES) break;
    if (!output.some((source) => source.url === candidate.url)) output.push(candidate);
  }
  return output.map(({ lane: _lane, ...source }) => Object.freeze(source));
}
