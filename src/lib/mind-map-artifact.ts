type MindMapArtifactNode = {
  id: string;
  label: string;
  detail?: string;
  color?: string;
};

type MindMapArtifactEdge = {
  from: string;
  to: string;
};

export type MindMapArtifactDocument = {
  title: string;
  nodes: MindMapArtifactNode[];
  edges: MindMapArtifactEdge[];
};

type Point = { x: number; y: number };

const NODE_WIDTH = 196;
const NODE_HEIGHT = 76;
const NODE_MARGIN = 16;
const RING_STEP = 230;

const PALETTES: Record<string, { fill: string; stroke: string; text: string }> = {
  green: { fill: "#082b27", stroke: "#37d6a5", text: "#d7fff3" },
  amber: { fill: "#312307", stroke: "#f6be43", text: "#fff3cf" },
  blue: { fill: "#08243b", stroke: "#53b8ff", text: "#e3f4ff" },
  pink: { fill: "#351328", stroke: "#f487be", text: "#ffe4f1" },
  slate: { fill: "#152235", stroke: "#8ba6c7", text: "#e8f1fb" },
};

function safeText(value: unknown, max: number): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function escapeXml(value: unknown, max: number): string {
  return safeText(value, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function layoutNodes(nodes: MindMapArtifactNode[]): { width: number; height: number; points: Map<string, Point> } {
  const count = Math.max(1, nodes.length);
  let remaining = Math.max(0, count - 1);
  let rings = 0;
  while (remaining > 0) {
    rings += 1;
    remaining -= 6 * rings;
  }
  const extent = Math.max(420, rings * RING_STEP + NODE_WIDTH / 2 + NODE_MARGIN * 3);
  const width = Math.round(extent * 2);
  const height = width;
  const centre = { x: width / 2, y: height / 2 };
  const points = new Map<string, Point>();
  if (nodes[0]) points.set(nodes[0].id, centre);

  let offset = 1;
  for (let ring = 1; offset < nodes.length; ring += 1) {
    const capacity = 6 * ring;
    const nodesInRing = Math.min(capacity, nodes.length - offset);
    for (let slot = 0; slot < nodesInRing; slot += 1) {
      const node = nodes[offset + slot];
      if (!node) continue;
      const angle = -Math.PI / 2 + (Math.PI * 2 * slot) / nodesInRing;
      points.set(node.id, {
        x: Math.round(centre.x + Math.cos(angle) * ring * RING_STEP),
        y: Math.round(centre.y + Math.sin(angle) * ring * RING_STEP),
      });
    }
    offset += nodesInRing;
  }
  return { width, height, points };
}

/**
 * Produces a self-contained, static SVG snapshot. It deliberately renders
 * text only: a saved mind map must not make browser clients fetch model- or
 * user-supplied URLs when it opens through the private creation media route.
 */
export function renderMindMapSvg(input: MindMapArtifactDocument): string {
  const title = safeText(input.title, 80) || "Mind map";
  const nodes = input.nodes.slice(0, 60).map((node, index) => ({
    id: safeText(node.id, 80) || `node-${index + 1}`,
    label: safeText(node.label, 80) || "Untitled",
    detail: safeText(node.detail, 140),
    color: safeText(node.color, 16),
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.edges
    .slice(0, 100)
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to);
  const { width, height, points } = layoutNodes(nodes);
  const titleY = 46;
  const edgeMarkup = edges.map((edge) => {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    if (!from || !to) return "";
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#5f7698" stroke-opacity="0.64" stroke-width="2"/>`;
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const point = points.get(node.id);
    if (!point) return "";
    const palette = PALETTES[node.color] ?? PALETTES.slate;
    const x = point.x - NODE_WIDTH / 2;
    const y = point.y - NODE_HEIGHT / 2;
    const detail = node.detail
      ? `<text x="${point.x}" y="${y + 53}" text-anchor="middle" fill="#b7c8db" font-family="Arial, sans-serif" font-size="11">${escapeXml(node.detail, 140)}</text>`
      : "";
    return `<g><rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="14" fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="2"/><text x="${point.x}" y="${y + 34}" text-anchor="middle" fill="${palette.text}" font-family="Arial, sans-serif" font-size="14" font-weight="700">${escapeXml(node.label, 80)}</text>${detail}</g>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title, 80)} mind map"><rect width="100%" height="100%" fill="#06111f"/><text x="${width / 2}" y="${titleY}" text-anchor="middle" fill="#dff8ff" font-family="Arial, sans-serif" font-size="24" font-weight="700">${escapeXml(title, 80)}</text>${edgeMarkup}${nodeMarkup}</svg>`;
}
