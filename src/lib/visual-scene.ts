export const VISUAL_BLOCK_KINDS = [
  "metrics",
  "progress",
  "sparkline",
  "line",
  "bar",
  "donut",
  "gauge",
  "candlestick",
  "heatmap",
  "table",
  "comparison",
  "timeline",
  "gantt",
  "kanban",
  "funnel",
  "matrix",
  "graph",
  "gallery",
  "link_grid",
  "activity",
  "map",
  "app",
] as const;

export type VisualBlockKind = (typeof VISUAL_BLOCK_KINDS)[number];

export const VISUAL_CAPABILITIES = [
  "executive_brief",
  "project_portfolio",
  "goal_roadmap",
  "agent_mission_control",
  "attention_radar",
  "notification_inbox",
  "rental_revenue",
  "youtube_pipeline",
  "wealth_dashboard",
  "price_hunts",
  "trading_alerts",
  "live_market",
  "decision_matrix",
  "option_comparison",
  "evidence_table",
  "delivery_timeline",
  "capacity_heatmap",
  "conversion_funnel",
  "idea_graph",
  "creative_gallery",
  "resource_links",
  "travel_storyboard",
] as const;

export type VisualCapability = (typeof VISUAL_CAPABILITIES)[number];
export type VisualTone = "cyan" | "green" | "amber" | "red" | "purple" | "blue" | "slate";
export type VisualSpan = "one" | "two" | "full";

export type VisualItem = {
  id?: string;
  label?: string;
  value?: string | number;
  secondary?: string | number;
  detail?: string;
  status?: string;
  tone?: VisualTone;
  icon?: string;
  url?: string;
  image?: string;
  progress?: number;
  start?: string | number;
  end?: string | number;
  x?: number;
  y?: number;
  lat?: number;
  lng?: number;
  group?: string;
  points?: number[];
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
};

export type VisualSeries = {
  id?: string;
  label: string;
  tone?: VisualTone;
  values: number[];
};

export type VisualEdge = { from: string; to: string; label?: string };

export type VisualBlock = {
  id: string;
  kind: VisualBlockKind;
  title?: string;
  subtitle?: string;
  span?: VisualSpan;
  tone?: VisualTone;
  source?: string;
  prefix?: string;
  suffix?: string;
  unit?: string;
  min?: number;
  max?: number;
  labels?: string[];
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
  items?: VisualItem[];
  series?: VisualSeries[];
  nodes?: VisualItem[];
  edges?: VisualEdge[];
};

export type VisualScene = {
  version: 1;
  title: string;
  subtitle?: string;
  capability?: VisualCapability;
  layout?: "dense" | "roomy";
  focusBlockId?: string;
  blocks: VisualBlock[];
  updatedAt: number;
};

const BLOCK_KIND_SET = new Set<string>(VISUAL_BLOCK_KINDS);
const CAPABILITY_SET = new Set<string>(VISUAL_CAPABILITIES);
const TONES = new Set<string>(["cyan", "green", "amber", "red", "purple", "blue", "slate"]);

const text = (value: unknown, max = 240): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result ? result.slice(0, max) : undefined;
};

const finite = (value: unknown): number | undefined => {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
};

const safeUrl = (value: unknown): string | undefined => {
  const result = text(value, 2_000);
  if (!result) return undefined;
  try {
    const parsed = new URL(result);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
};

const tone = (value: unknown): VisualTone | undefined => {
  const result = text(value, 16);
  return result && TONES.has(result) ? (result as VisualTone) : undefined;
};

function normalizeItem(value: unknown, index: number): VisualItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const item: VisualItem = {
    id: text(row.id, 80) ?? `item-${index + 1}`,
    label: text(row.label, 180),
    value: typeof row.value === "number" ? finite(row.value) : text(row.value, 240),
    secondary: typeof row.secondary === "number" ? finite(row.secondary) : text(row.secondary, 160),
    detail: text(row.detail, 800),
    status: text(row.status, 80),
    tone: tone(row.tone),
    icon: text(row.icon, 12),
    url: safeUrl(row.url),
    image: safeUrl(row.image),
    progress: finite(row.progress),
    start: typeof row.start === "number" ? finite(row.start) : text(row.start, 80),
    end: typeof row.end === "number" ? finite(row.end) : text(row.end, 80),
    x: finite(row.x),
    y: finite(row.y),
    lat: finite(row.lat),
    lng: finite(row.lng),
    group: text(row.group, 120),
    points: Array.isArray(row.points) ? row.points.map(finite).filter((n): n is number => n !== undefined).slice(0, 160) : undefined,
    open: finite(row.open),
    high: finite(row.high),
    low: finite(row.low),
    close: finite(row.close),
    volume: finite(row.volume),
  };
  return item;
}

export function normalizeVisualBlock(value: unknown, index = 0): VisualBlock | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = text(row.kind, 30);
  if (!kind || !BLOCK_KIND_SET.has(kind)) return null;
  const rawSpan = text(row.span, 16);
  const block: VisualBlock = {
    id: text(row.id, 80) ?? `block-${index + 1}`,
    kind: kind as VisualBlockKind,
    title: text(row.title, 160),
    subtitle: text(row.subtitle, 400),
    span: rawSpan === "one" || rawSpan === "two" || rawSpan === "full" ? rawSpan : undefined,
    tone: tone(row.tone),
    source: text(row.source, 120),
    prefix: text(row.prefix, 24),
    suffix: text(row.suffix, 24),
    unit: text(row.unit, 40),
    min: finite(row.min),
    max: finite(row.max),
    labels: Array.isArray(row.labels) ? row.labels.map((label) => text(label, 80)).filter((label): label is string => !!label).slice(0, 80) : undefined,
    columns: Array.isArray(row.columns) ? row.columns.map((column) => text(column, 80)).filter((column): column is string => !!column).slice(0, 16) : undefined,
    rows: Array.isArray(row.rows)
      ? row.rows.slice(0, 80).map((cells) =>
          Array.isArray(cells)
            ? cells.slice(0, 16).map((cell) => (typeof cell === "number" ? finite(cell) ?? null : text(cell, 240) ?? null))
            : [],
        )
      : undefined,
    items: Array.isArray(row.items)
      ? row.items.map(normalizeItem).filter((item): item is VisualItem => !!item).slice(0, 80)
      : undefined,
    series: Array.isArray(row.series)
      ? row.series
          .map((series, seriesIndex): VisualSeries | null => {
            if (!series || typeof series !== "object") return null;
            const entry = series as Record<string, unknown>;
            const label = text(entry.label, 120);
            if (!label || !Array.isArray(entry.values)) return null;
            return {
              id: text(entry.id, 80) ?? `series-${seriesIndex + 1}`,
              label,
              tone: tone(entry.tone),
              values: entry.values.map(finite).filter((number): number is number => number !== undefined).slice(0, 160),
            };
          })
          .filter((series): series is VisualSeries => !!series)
          .slice(0, 12)
      : undefined,
    nodes: Array.isArray(row.nodes)
      ? row.nodes.map(normalizeItem).filter((item): item is VisualItem => !!item).slice(0, 80)
      : undefined,
    edges: Array.isArray(row.edges)
      ? row.edges
          .map((edge): VisualEdge | null => {
            if (!edge || typeof edge !== "object") return null;
            const entry = edge as Record<string, unknown>;
            const from = text(entry.from, 80);
            const to = text(entry.to, 80);
            return from && to ? { from, to, label: text(entry.label, 120) } : null;
          })
          .filter((edge): edge is VisualEdge => !!edge)
          .slice(0, 160)
      : undefined,
  };
  return block;
}

export function normalizeVisualScene(value: unknown, fallbackTitle = "Visual workspace"): VisualScene {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const capability = text(row.capability, 50);
  const rawLayout = text(row.layout, 16);
  return {
    version: 1,
    title: text(row.title, 160) ?? fallbackTitle,
    subtitle: text(row.subtitle, 500),
    capability: capability && CAPABILITY_SET.has(capability) ? (capability as VisualCapability) : undefined,
    layout: rawLayout === "dense" || rawLayout === "roomy" ? rawLayout : "dense",
    focusBlockId: text(row.focusBlockId ?? row.focus_block_id, 80),
    blocks: Array.isArray(row.blocks)
      ? row.blocks.map(normalizeVisualBlock).filter((block): block is VisualBlock => !!block).slice(0, 24)
      : [],
    updatedAt: finite(row.updatedAt) ?? Date.now(),
  };
}

export function mergeVisualScene(
  current: VisualScene | null,
  input: Record<string, unknown>,
): VisualScene {
  const base = current ?? normalizeVisualScene(input, text(input.title, 160) ?? "Visual workspace");
  const incoming = Array.isArray(input.blocks)
    ? input.blocks.map(normalizeVisualBlock).filter((block): block is VisualBlock => !!block)
    : [];
  const remove = new Set(
    Array.isArray(input.remove) ? input.remove.map((id) => text(id, 80)).filter((id): id is string => !!id) : [],
  );
  const byId = new Map(base.blocks.filter((block) => !remove.has(block.id)).map((block) => [block.id, block]));
  for (const block of incoming) {
    const previous = byId.get(block.id);
    byId.set(block.id, previous ? normalizeVisualBlock({ ...previous, ...block }, 0) ?? block : block);
  }
  const capability = text(input.capability, 50);
  const rawLayout = text(input.layout, 16);
  return {
    ...base,
    title: text(input.title, 160) ?? base.title,
    subtitle: input.subtitle === null ? undefined : text(input.subtitle, 500) ?? base.subtitle,
    capability: capability && CAPABILITY_SET.has(capability) ? (capability as VisualCapability) : base.capability,
    layout: rawLayout === "dense" || rawLayout === "roomy" ? rawLayout : base.layout,
    focusBlockId:
      input.focus_block_id === null || input.focusBlockId === null
        ? undefined
        : text(input.focus_block_id ?? input.focusBlockId, 80) ?? base.focusBlockId,
    blocks: [...byId.values()].slice(0, 24),
    updatedAt: Date.now(),
  };
}

export function parseVisualSceneJson(value: string, fallbackTitle?: string): VisualScene {
  try {
    return normalizeVisualScene(JSON.parse(value), fallbackTitle);
  } catch {
    return normalizeVisualScene({}, fallbackTitle);
  }
}

const capabilitySources: Partial<Record<VisualCapability, Array<{ id: string; title: string; source: string }>>> = {
  executive_brief: [
    { id: "attention", title: "Needs attention", source: "attention" },
    { id: "projects", title: "Project pulse", source: "projects" },
    { id: "team", title: "Team in motion", source: "agents" },
    { id: "inbox", title: "Fresh intelligence", source: "findings" },
  ],
  project_portfolio: [{ id: "projects", title: "Project portfolio", source: "projects" }],
  agent_mission_control: [{ id: "team", title: "Permanent team", source: "agents" }],
  attention_radar: [{ id: "attention", title: "Ranked attention", source: "attention" }],
  notification_inbox: [
    { id: "intelligence", title: "Fresh intelligence", source: "findings" },
    { id: "reminders", title: "Coming up", source: "reminders" },
  ],
  rental_revenue: [{ id: "rental", title: "Rental business", source: "business:rental" }],
  youtube_pipeline: [{ id: "youtube", title: "YouTube pipeline", source: "business:youtube" }],
  wealth_dashboard: [{ id: "wealth", title: "Wealth", source: "business:wealth" }],
  price_hunts: [{ id: "hunts", title: "Active price hunts", source: "watches" }],
};

export function materializeCapability(scene: VisualScene): VisualScene {
  if (scene.blocks.length || !scene.capability) return scene;
  const bound = capabilitySources[scene.capability];
  if (bound) {
    return {
      ...scene,
      blocks: bound.map((item, index) => ({
        id: item.id,
        kind: "app",
        title: item.title,
        source: item.source,
        span: bound.length === 1 ? "full" : index === 0 ? "two" : "one",
      })),
    };
  }
  const kindByCapability: Partial<Record<VisualCapability, VisualBlockKind>> = {
    goal_roadmap: "timeline",
    trading_alerts: "candlestick",
    live_market: "candlestick",
    decision_matrix: "matrix",
    option_comparison: "comparison",
    evidence_table: "table",
    delivery_timeline: "gantt",
    capacity_heatmap: "heatmap",
    conversion_funnel: "funnel",
    idea_graph: "graph",
    creative_gallery: "gallery",
    resource_links: "link_grid",
    travel_storyboard: "timeline",
  };
  const kind = kindByCapability[scene.capability];
  return kind
    ? { ...scene, blocks: [{ id: scene.capability, kind, title: scene.title, span: "full" }] }
    : scene;
}
