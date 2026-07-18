export const BOARD_SEMANTIC_CATEGORIES = [
  "character",
  "location",
  "plot",
  "timeline",
  "visual",
  "relationship",
  "theme",
  "object",
  "question",
  "note",
] as const;

export type BoardSemanticCategory = (typeof BOARD_SEMANTIC_CATEGORIES)[number];

export type BoardSemanticNode = {
  id: string;
  category: BoardSemanticCategory;
  title: string;
  detail?: string;
  zone: string;
  x: number;
  y: number;
  w: number;
  h: number;
  relatedIds?: string[];
  sequence?: number;
  imagePrompt?: string;
  imageUrl?: string;
  sourceText?: string;
  certainty?: "stated" | "inferred" | "question";
  updatedAt: number;
};

export type BoardSemanticEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: "relation" | "sequence" | "attachment";
};

export type BoardCaptureInput = {
  id?: unknown;
  category?: unknown;
  title?: unknown;
  detail?: unknown;
  related_ids?: unknown;
  sequence?: unknown;
  image_prompt?: unknown;
  image_url?: unknown;
  certainty?: unknown;
};

const ZONE_BY_CATEGORY: Record<BoardSemanticCategory, string[]> = {
  character: ["characters", "people", "ideas"],
  location: ["locations", "route", "ideas"],
  plot: ["plot", "storyboard", "tasks", "ideas"],
  timeline: ["timeline", "storyboard", "route", "ideas"],
  visual: ["moodboard", "evidence", "ideas"],
  relationship: ["relationships", "characters", "people", "ideas"],
  theme: ["themes", "moodboard", "ideas"],
  object: ["objects", "evidence", "moodboard", "ideas"],
  question: ["questions", "notes", "ideas"],
  note: ["notes", "ideas"],
};

const CATEGORY_ALIASES: Record<string, BoardSemanticCategory> = {
  characters: "character",
  person: "character",
  people: "character",
  locations: "location",
  setting: "location",
  settings: "location",
  action: "plot",
  event: "plot",
  beat: "plot",
  time: "timeline",
  sequence: "timeline",
  image: "visual",
  moodboard: "visual",
  reference: "visual",
  relationships: "relationship",
  motif: "theme",
  prop: "object",
  props: "object",
  questions: "question",
  notes: "note",
};

function trim(value: unknown, max: number): string | undefined {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : undefined;
}

export function normalizeBoardCategory(value: unknown): BoardSemanticCategory {
  const raw = String(value ?? "note").toLowerCase().trim();
  if ((BOARD_SEMANTIC_CATEGORIES as readonly string[]).includes(raw)) return raw as BoardSemanticCategory;
  return CATEGORY_ALIASES[raw] ?? "note";
}

export function boardZoneForCategory(category: BoardSemanticCategory, zones: Record<string, unknown>): string {
  return ZONE_BY_CATEGORY[category].find((candidate) => candidate in zones) ?? Object.keys(zones)[0] ?? "ideas";
}

export function normalizeBoardCapture(input: BoardCaptureInput, index: number): {
  id: string;
  category: BoardSemanticCategory;
  title: string;
  detail?: string;
  relatedIds: string[];
  sequence?: number;
  imagePrompt?: string;
  imageUrl?: string;
  certainty: "stated" | "inferred" | "question";
} | null {
  const title = trim(input.title, 100);
  if (!title) return null;
  const category = normalizeBoardCategory(input.category);
  const fallbackId = `${category}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  const id = trim(input.id, 64)?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || fallbackId || `${category}-${index + 1}`;
  const relatedIds = (Array.isArray(input.related_ids) ? input.related_ids : [])
    .map((value) => trim(value, 64)?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))
    .filter((value): value is string => Boolean(value && value !== id))
    .slice(0, 12);
  const rawSequence = Number(input.sequence);
  const imageUrl = trim(input.image_url, 500);
  const certaintyRaw = String(input.certainty ?? "stated");
  const certainty = certaintyRaw === "inferred" || certaintyRaw === "question" ? certaintyRaw : "stated";
  return {
    id,
    category,
    title,
    detail: trim(input.detail, 500),
    relatedIds,
    sequence: Number.isFinite(rawSequence) ? rawSequence : undefined,
    imagePrompt: trim(input.image_prompt, 800),
    imageUrl: imageUrl && /^https?:\/\//.test(imageUrl) ? imageUrl : undefined,
    certainty,
  };
}

export function semanticCategoryLabel(category: BoardSemanticCategory): string {
  return category === "plot" ? "PLOT BEAT" : category.toUpperCase();
}
