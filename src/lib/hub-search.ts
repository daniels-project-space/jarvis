export type HubSearchSnapshot = {
  todos?: Array<{
    _id?: string;
    text?: string;
    priority?: number;
    dueDate?: number;
    tags?: string[];
    projectSlug?: string;
  }>;
  events?: Array<{
    _id?: string;
    title?: string;
    start?: number;
    location?: string;
    notes?: string;
  }>;
};

export type HubSearchResult = {
  id: string;
  kind: "todo" | "event";
  title: string;
  detail: string;
  target: "todo" | "calendar";
};

const WORD = /[a-z0-9][a-z0-9-]{1,}/gi;

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(WORD) ?? [])].slice(0, 8);
}

function score(query: string, title: string, detail: string): number {
  const q = query.toLowerCase();
  const normalizedTitle = title.toLowerCase();
  const normalizedDetail = detail.toLowerCase();
  let value = normalizedTitle.startsWith(q) ? 120 : normalizedTitle.includes(q) ? 70 : normalizedDetail.includes(q) ? 25 : 0;
  for (const term of terms(q)) {
    if (normalizedTitle.includes(term)) value += 18;
    if (normalizedDetail.includes(term)) value += 6;
  }
  return value;
}

function short(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Bounded projection of the existing capability-scoped Hub snapshot. */
export function searchHubSnapshot(
  rawQuery: string,
  snapshot: HubSearchSnapshot | null | undefined,
  limit = 8,
): HubSearchResult[] {
  const query = rawQuery.trim().slice(0, 120);
  if (query.length < 2 || !snapshot) return [];
  const candidates: Array<HubSearchResult & { score: number }> = [];

  for (const [index, todo] of (snapshot.todos ?? []).slice(0, 20).entries()) {
    const title = short(todo.text, 100);
    if (!title) continue;
    const detail = [todo.projectSlug, ...(todo.tags ?? []).slice(0, 4), Number.isFinite(todo.dueDate) ? new Date(todo.dueDate as number).toISOString().slice(0, 10) : ""]
      .filter(Boolean)
      .join(" · ");
    const relevance = score(query, title, detail);
    if (relevance) candidates.push({
      id: `hub:todo:${short(todo._id, 80) || index}`,
      kind: "todo",
      title,
      detail: detail || "Project Hub to-do",
      target: "todo",
      score: relevance,
    });
  }

  for (const [index, event] of (snapshot.events ?? []).slice(0, 12).entries()) {
    const title = short(event.title, 100);
    if (!title) continue;
    const detail = [event.location, event.notes, Number.isFinite(event.start) ? new Date(event.start as number).toISOString().slice(0, 10) : ""]
      .map((value) => short(value, 80))
      .filter(Boolean)
      .join(" · ");
    const relevance = score(query, title, detail);
    if (relevance) candidates.push({
      id: `hub:event:${short(event._id, 80) || index}`,
      kind: "event",
      title,
      detail: detail || "Project Hub calendar",
      target: "calendar",
      score: relevance,
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, Math.max(1, Math.min(12, Math.floor(limit))))
    .map(({ score: _score, ...result }) => result);
}
