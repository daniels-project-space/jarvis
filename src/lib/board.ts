import "server-only";
import { convexMutation, convexQuery } from "./context";

// The board engine — JARVIS's infinite canvas (rendered client-side by
// Excalidraw). The brain works in ZONES (named regions) and high-level items
// (notes, tables, images, arrows); this module turns them into Excalidraw
// element skeletons queued as ops the open board applies live.

type Zone = { x: number; y: number; w: number; h: number; cursor: number };
export type BoardDoc = {
  kind: "board";
  title: string;
  project?: string;
  zones: Record<string, Zone>;
  pendingOps: any[]; // {ts, kind:"skeleton"|"image", ...}
  elements: any[]; // full excalidraw elements — client-persisted
  imageUrls: Record<string, string>;
};

const COLORS: Record<string, string> = {
  green: "#0fbf7f",
  amber: "#f5a623",
  blue: "#4a9eed",
  pink: "#e64980",
  purple: "#9775fa",
  slate: "#697586",
  yellow: "#f7d154",
};
const color = (c?: string) => COLORS[String(c ?? "")] ?? COLORS.green;

// Film/worldbuilding template — the spatial layout Daniel described: character
// map, locations, rendered moodboard, storyboard breakdown, playlist, notes.
const TEMPLATES: Record<string, { name: string; w: number; h: number }[][]> = {
  film: [
    [
      { name: "characters", w: 1800, h: 1300 },
      { name: "locations", w: 1800, h: 1300 },
      { name: "moodboard", w: 1800, h: 1300 },
    ],
    [
      { name: "storyboard", w: 3700, h: 1300 },
      { name: "playlist", w: 1800, h: 1300 },
    ],
    [{ name: "notes", w: 5600, h: 900 }],
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
            label: { text: String(cell).slice(0, 40), fontSize: 15, strokeColor: ri === 0 ? "#eef4fb" : "#1b2733" },
          }),
        ),
      ),
    );
    return ops;
  }
  if (kind === "text") {
    const p = place(doc, item.zone, item.x, item.y, 500, 60);
    return [skel({ type: "text", x: p.x, y: p.y, text, fontSize: item.big ? 34 : 20, strokeColor: c, link })];
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
      strokeColor: c,
      backgroundColor: kind === "note" ? c : "transparent",
      fillStyle: kind === "note" ? "hachure" : "solid",
      roundness: shape === "rectangle" ? { type: 3 } : undefined,
      link,
      label: text ? { text, fontSize: 17, strokeColor: "#1b2733" } : undefined,
    }),
  ];
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

export async function createBoard(title: string, template: string, project?: string): Promise<{ id: string; doc: BoardDoc }> {
  const { zones, ops } = buildZones(template);
  const doc: BoardDoc = { kind: "board", title, project, zones, pendingOps: ops, elements: [], imageUrls: {} };
  const id = await convexMutation("creations:create", { kind: "board", title, data: JSON.stringify(doc) });
  await convexMutation("ui:setPanel", { type: "board", value: JSON.stringify({ creationId: String(id) }), title: `board · ${title}` });
  if (project)
    await convexMutation("memory:write", {
      kind: "project",
      title: `Board started: ${title}`,
      body: `Working board "${title}" (template ${template}) for project ${project} — lives in the creations library.`,
      tags: ["board", project],
    }).catch(() => {});
  return { id: String(id), doc };
}

export async function saveBoardDoc(id: string, doc: BoardDoc, show = true): Promise<void> {
  await convexMutation("creations:update", { id, title: doc.title, data: JSON.stringify(doc) });
  if (show)
    await convexMutation("ui:setPanel", { type: "board", value: JSON.stringify({ creationId: id }), title: `board · ${doc.title}` });
}
