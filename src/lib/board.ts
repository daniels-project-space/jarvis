import "server-only";
import { convexMutation, convexQuery } from "./context";
import {
  type BoardCaptureInput,
  type BoardSemanticEdge,
  type BoardSemanticNode,
  boardZoneForCategory,
  normalizeBoardCapture,
  semanticCategoryLabel,
} from "./board-semantic";

// The board engine — JARVIS's infinite canvas (rendered client-side by
// Excalidraw). The brain works in ZONES (named regions) and high-level items
// (notes, tables, images, arrows); this module turns them into Excalidraw
// element skeletons queued as ops the open board applies live.

type Zone = { x: number; y: number; w: number; h: number; cursor: number };
export type BoardDoc = {
  kind: "board";
  version?: 2;
  title: string;
  project?: string;
  inquiry?: string;
  zones: Record<string, Zone>;
  pendingOps: any[]; // {ts, kind:"skeleton"|"image", ...}
  elements: any[]; // full excalidraw elements — client-persisted
  imageUrls: Record<string, string>;
  semanticNodes?: Record<string, BoardSemanticNode>;
  semanticEdges?: BoardSemanticEdge[];
  sourceLog?: { text: string; nodeIds: string[]; capturedAt: number }[];
};

// Excalidraw's own pastel palette — designed to survive the dark-theme invert
// filter, and reads like real sticky notes in a sketchbook.
const COLORS: Record<string, string> = {
  green: "#b2f2bb",
  amber: "#ffd8a8",
  blue: "#a5d8ff",
  pink: "#fcc2d7",
  purple: "#d0bfff",
  slate: "#dee2e6",
  yellow: "#ffec99",
};
const INK = "#1e1e1e"; // sticky-note ink
const color = (c?: string) => COLORS[String(c ?? "")] ?? COLORS.green;

// Film/worldbuilding template — the spatial layout Daniel described: character
// map, locations, rendered moodboard, storyboard breakdown, playlist, notes.
const TEMPLATES: Record<string, { name: string; w: number; h: number }[][]> = {
  film: [
    [
      { name: "characters", w: 1500, h: 1100 },
      { name: "locations", w: 1500, h: 1100 },
      { name: "themes", w: 1500, h: 1100 },
    ],
    [
      { name: "plot", w: 1500, h: 1100 },
      { name: "timeline", w: 1500, h: 1100 },
      { name: "relationships", w: 1500, h: 1100 },
    ],
    [
      { name: "moodboard", w: 2300, h: 1250 },
      { name: "storyboard", w: 2300, h: 1250 },
    ],
    [
      { name: "questions", w: 1500, h: 800 },
      { name: "notes", w: 3100, h: 800 },
    ],
  ],
  scavenger: [
    [
      { name: "choices", w: 1900, h: 1200 },
      { name: "clues", w: 2500, h: 1200 },
      { name: "route", w: 1900, h: 1200 },
    ],
    [
      { name: "tasks", w: 1900, h: 1050 },
      { name: "people", w: 1900, h: 1050 },
      { name: "evidence", w: 2500, h: 1050 },
    ],
    [{ name: "notes", w: 6600, h: 850 }],
  ],
  blank: [[{ name: "ideas", w: 2400, h: 1600 }]],
};

function buildZones(template: string): { zones: Record<string, Zone>; ops: any[] } {
  const rows = TEMPLATES[template] ?? TEMPLATES.blank;
  const zones: Record<string, Zone> = {};
  const ops: any[] = [];
  const GAP = 260;
  let y = 0;
  for (const row of rows) {
    let x = 0;
    let rowH = 0;
    for (const z of row) {
      zones[z.name] = { x, y, w: z.w, h: z.h, cursor: 0 };
      ops.push(
        skel({
          type: "rectangle",
          x,
          y,
          width: z.w,
          height: z.h,
          strokeColor: "#3d4d63",
          backgroundColor: "transparent",
          strokeStyle: "dashed",
          roughness: 0,
        }),
        skel({ type: "text", x: x + 16, y: y - 60, text: z.name.toUpperCase(), fontSize: 36, strokeColor: "#697586" }),
      );
      x += z.w + GAP;
      rowH = Math.max(rowH, z.h);
    }
    y += rowH + GAP + 80;
  }
  return { zones, ops };
}

const skel = (s: Record<string, unknown>) => ({ ts: Date.now(), kind: "skeleton", skel: s });

// Grid placement inside a zone (3 columns), or free x/y when given.
function place(doc: BoardDoc, zone: string | undefined, x?: number, y?: number, w = 300, h = 190): { x: number; y: number } {
  if (typeof x === "number" && typeof y === "number") return { x, y };
  const z = doc.zones[zone ?? ""] ?? doc.zones[Object.keys(doc.zones)[0]];
  if (!z) return { x: 0, y: 0 };
  const cols = Math.max(1, Math.floor((z.w - 60) / (w + 40)));
  const i = z.cursor++;
  return {
    x: z.x + 40 + (i % cols) * (w + 40),
    y: z.y + 90 + Math.floor(i / cols) * (h + 46),
  };
}

export function itemToOps(doc: BoardDoc, item: any): any[] {
  const kind = String(item.kind ?? "note");
  const c = color(item.color);
  const text = String(item.text ?? item.label ?? "").slice(0, 600);
  const link = item.url && /^https?:/.test(String(item.url)) ? String(item.url).slice(0, 400) : undefined;

  if (kind === "image" && item.image_url) {
    const p = place(doc, item.zone, item.x, item.y, item.w ?? 460, item.h ?? 300);
    return [{ ts: Date.now(), kind: "image", url: String(item.image_url), x: p.x, y: p.y, w: item.w ?? 460, h: item.h ?? 300, link }];
  }
  if (kind === "table" && Array.isArray(item.rows)) {
    const rows: string[][] = item.rows.slice(0, 12).map((r: any) => (Array.isArray(r) ? r.slice(0, 6).map(String) : [String(r)]));
    const cols = Math.max(...rows.map((r) => r.length));
    const cw = Math.min(280, Math.max(140, Math.round(900 / cols)));
    const ch = 52;
    const p = place(doc, item.zone, item.x, item.y, cols * cw, rows.length * ch + 40);
    const ops: any[] = [];
    if (text) ops.push(skel({ type: "text", x: p.x, y: p.y - 44, text, fontSize: 24, strokeColor: c }));
    rows.forEach((r, ri) =>
      r.forEach((cell, ci) =>
        ops.push(
          skel({
            type: "rectangle",
            x: p.x + ci * cw,
            y: p.y + ri * ch,
            width: cw,
            height: ch,
            strokeColor: "#3d4d63",
            backgroundColor: ri === 0 ? c : "transparent",
            fillStyle: "solid",
            roughness: 0,
            label: { text: String(cell).slice(0, 40), fontSize: 15, strokeColor: INK },
          }),
        ),
      ),
    );
    return ops;
  }
  if (kind === "text") {
    const p = place(doc, item.zone, item.x, item.y, 500, 60);
    return [skel({ type: "text", x: p.x, y: p.y, text, fontSize: item.big ? 34 : 20, strokeColor: INK, link })];
  }
  if (kind === "arrow") {
    const p = place(doc, item.zone, item.x, item.y, 300, 80);
    return [
      skel({
        type: "arrow",
        x: p.x,
        y: p.y,
        width: item.w ?? 260,
        height: item.h ?? 0,
        strokeColor: c,
        label: text ? { text: text.slice(0, 40), fontSize: 15 } : undefined,
      }),
    ];
  }
  // note / rect / ellipse / diamond — a labelled container
  const shape = ["ellipse", "diamond", "rectangle"].includes(kind) ? kind : "rectangle";
  const w = item.w ?? 300;
  const h = item.h ?? 170;
  const p = place(doc, item.zone, item.x, item.y, w, h);
  return [
    skel({
      type: shape,
      x: p.x,
      y: p.y,
      width: w,
      height: h,
      strokeColor: INK,
      backgroundColor: kind === "note" ? c : "transparent",
      fillStyle: "solid",
      roundness: shape === "rectangle" ? { type: 3 } : undefined,
      link,
      label: text ? { text, fontSize: 17, strokeColor: INK } : undefined,
    }),
  ];
}

const SEMANTIC_COLORS: Record<string, string> = {
  character: "pink",
  location: "blue",
  plot: "amber",
  timeline: "yellow",
  visual: "purple",
  relationship: "pink",
  theme: "purple",
  object: "green",
  question: "slate",
  note: "green",
};

function semanticCardOps(node: BoardSemanticNode): any[] {
  const certainty = node.certainty === "inferred" ? " · INFERRED" : node.certainty === "question" ? " · OPEN" : "";
  const detail = node.detail ? node.detail.slice(0, 360) : "";
  const body = [node.title, detail].filter(Boolean).join("\n\n");
  const ops: any[] = [
    skel({
      type: "rectangle",
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      strokeColor: "#34455d",
      backgroundColor: color(SEMANTIC_COLORS[node.category]),
      fillStyle: "solid",
      roughness: 0,
      roundness: { type: 3 },
      label: { text: body, fontSize: 18, strokeColor: INK },
    }),
    skel({
      type: "text",
      x: node.x + 14,
      y: node.y - 28,
      text: `${semanticCategoryLabel(node.category)}${certainty}`,
      fontSize: 13,
      strokeColor: color(SEMANTIC_COLORS[node.category]),
    }),
  ];
  if (node.imagePrompt && !node.imageUrl) {
    ops.push(
      skel({
        type: "text",
        x: node.x + 14,
        y: node.y + node.h + 12,
        text: `VISUAL PROMPT · ${node.imagePrompt.slice(0, 220)}`,
        fontSize: 13,
        strokeColor: "#9c6ade",
      }),
    );
  }
  return ops;
}

/**
 * Convert one spoken idea into a semantic graph. `captures` is deliberately a
 * batch: the same source sentence can create a character, setting, action,
 * timeline beat and visual reference without forcing it into one bucket.
 */
export function capturesToOps(doc: BoardDoc, inputs: BoardCaptureInput[], sourceText?: string): { added: number; updated: number; ops: any[] } {
  doc.version = 2;
  doc.semanticNodes ??= {};
  doc.semanticEdges ??= [];
  const captures = inputs.map(normalizeBoardCapture).filter((value): value is NonNullable<typeof value> => Boolean(value)).slice(0, 30);
  const ops: any[] = [];
  let added = 0;
  let updated = 0;

  // Position the full batch first so arrows can connect nodes regardless of
  // the order the model emitted them in.
  for (const capture of captures) {
    const previous = doc.semanticNodes[capture.id];
    const zone = previous?.zone ?? boardZoneForCategory(capture.category, doc.zones);
    const dimensions = capture.category === "visual" ? { w: 420, h: 240 } : { w: 330, h: capture.detail ? 190 : 150 };
    const position = previous ?? place(doc, zone, undefined, undefined, dimensions.w, dimensions.h);
    doc.semanticNodes[capture.id] = {
      id: capture.id,
      category: capture.category,
      title: capture.title,
      detail: capture.detail,
      zone,
      x: position.x,
      y: position.y,
      w: previous?.w ?? dimensions.w,
      h: previous?.h ?? dimensions.h,
      relatedIds: capture.relatedIds,
      sequence: capture.sequence,
      imagePrompt: capture.imagePrompt,
      imageUrl: capture.imageUrl,
      sourceText: sourceText?.slice(0, 1_000),
      certainty: capture.certainty,
      updatedAt: Date.now(),
    };
    if (previous) {
      updated += 1;
      ops.push({ ts: Date.now(), kind: "delete", match: previous.title });
    } else added += 1;
  }

  for (const capture of captures) {
    const node = doc.semanticNodes[capture.id];
    ops.push(...semanticCardOps(node));
    if (node.imageUrl) {
      const imageZone = doc.zones.moodboard ? "moodboard" : node.zone;
      const visualPosition = place(doc, imageZone, undefined, undefined, 520, 340);
      ops.push({ ts: Date.now(), kind: "image", url: node.imageUrl, x: visualPosition.x, y: visualPosition.y, w: 520, h: 340 });
      ops.push(skel({ type: "text", x: visualPosition.x, y: visualPosition.y - 34, text: node.title, fontSize: 20, strokeColor: "#9c6ade" }));
      const timelineTargets = [node, ...(node.relatedIds ?? []).map((id) => doc.semanticNodes?.[id]).filter(Boolean)].filter(
        (candidate): candidate is BoardSemanticNode => candidate?.category === "timeline",
      );
      for (const target of timelineTargets.slice(0, 3)) {
        // A scene render remains in the moodboard library and is also pinned
        // directly beneath each linked timeline beat for chronological review.
        ops.push({ ts: Date.now(), kind: "image", url: node.imageUrl, x: target.x, y: target.y + target.h + 24, w: 330, h: 205 });
      }
    }
  }

  const edgeKeys = new Set(doc.semanticEdges.map((edge) => `${edge.from}|${edge.to}|${edge.kind ?? "relation"}`));
  for (const capture of captures) {
    const from = doc.semanticNodes[capture.id];
    for (const relatedId of capture.relatedIds) {
      const to = doc.semanticNodes[relatedId];
      if (!to) continue;
      const key = `${from.id}|${to.id}|relation`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      doc.semanticEdges.push({ id: `edge-${from.id}-${to.id}`, from: from.id, to: to.id, kind: "relation" });
      ops.push(
        skel({
          type: "arrow",
          x: from.x + from.w / 2,
          y: from.y + from.h / 2,
          width: to.x + to.w / 2 - (from.x + from.w / 2),
          height: to.y + to.h / 2 - (from.y + from.h / 2),
          strokeColor: "#74839a",
          strokeWidth: 2,
          endArrowhead: "arrow",
        }),
      );
    }
  }

  const timeline = Object.values(doc.semanticNodes)
    .filter((node) => node.category === "timeline" && Number.isFinite(node.sequence))
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  for (let index = 1; index < timeline.length; index += 1) {
    const from = timeline[index - 1];
    const to = timeline[index];
    const key = `${from.id}|${to.id}|sequence`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    doc.semanticEdges.push({ id: `sequence-${from.id}-${to.id}`, from: from.id, to: to.id, kind: "sequence" });
    ops.push(
      skel({
        type: "arrow",
        x: from.x + from.w,
        y: from.y + from.h / 2,
        width: to.x - (from.x + from.w),
        height: to.y + to.h / 2 - (from.y + from.h / 2),
        strokeColor: "#d19a28",
        strokeWidth: 3,
        endArrowhead: "arrow",
        label: { text: "NEXT", fontSize: 12 },
      }),
    );
  }

  if (sourceText?.trim()) {
    doc.sourceLog ??= [];
    doc.sourceLog = [
      ...doc.sourceLog,
      { text: sourceText.trim().slice(0, 1_000), nodeIds: captures.map((capture) => capture.id), capturedAt: Date.now() },
    ].slice(-100);
  }
  return { added, updated, ops };
}

export async function loadBoard(titleMatch?: string): Promise<{ id: string; doc: BoardDoc } | null> {
  const row: any = await convexQuery("creations:latest", { kind: "board", titleMatch });
  if (!row?.data) return null;
  try {
    return { id: String(row._id), doc: JSON.parse(row.data) };
  } catch {
    return null;
  }
}

export async function createBoard(
  title: string,
  template: string,
  filing?: { project?: string; inquiry?: string; threadId?: string },
): Promise<{ id: string; doc: BoardDoc }> {
  const { zones, ops } = buildZones(template);
  const doc: BoardDoc = {
    kind: "board",
    version: 2,
    title,
    project: filing?.project,
    inquiry: filing?.inquiry,
    zones,
    pendingOps: ops,
    elements: [],
    imageUrls: {},
    semanticNodes: {},
    semanticEdges: [],
    sourceLog: [],
  };
  const id = await convexMutation("creations:create", {
    kind: "board",
    title,
    data: JSON.stringify(doc),
    category: "boards",
    project: filing?.project,
    inquiry: filing?.inquiry,
    threadId: filing?.threadId,
  });
  await convexMutation("ui:setPanel", { type: "board", value: JSON.stringify({ creationId: String(id) }), title: `board · ${title}` });
  if (filing?.project)
    await convexMutation("memory:write", {
      kind: "project",
      title: `Board started: ${title}`,
      body: `Working board "${title}" (template ${template}) for project ${filing.project} — lives in the creations library.`,
      tags: ["board", filing.project],
    }).catch(() => {});
  return { id: String(id), doc };
}

export async function saveBoardDoc(id: string, doc: BoardDoc, show = true): Promise<void> {
  await convexMutation("creations:update", { id, title: doc.title, data: JSON.stringify(doc) });
  if (show)
    await convexMutation("ui:setPanel", { type: "board", value: JSON.stringify({ creationId: id }), title: `board · ${doc.title}` });
}
