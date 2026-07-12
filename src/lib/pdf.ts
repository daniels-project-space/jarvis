import "server-only";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib";

// Markdown → clean A4 PDF, JARVIS-branded. Pure JS (pdf-lib), serverless-safe.
// Supports #/##/### headings, bullets, numbered lists, bold-stripped body text.

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const INK = rgb(0.12, 0.14, 0.18);
const SOFT = rgb(0.45, 0.5, 0.58);
const ACCENT = rgb(0, 0.62, 0.4);

// WinAnsi can't encode emoji/CJK — replace anything outside latin-1 print range.
const sanitize = (s: string) =>
  s.replace(/[\u{0100}-\u{10FFFF}]/gu, "?").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/\t/g, "  ");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const probe = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(probe, size) <= width) cur = probe;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

export async function markdownToPdf(title: string, markdown: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const usable = A4[0] - MARGIN * 2;
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGIN;

  const newPageIfNeeded = (need: number) => {
    if (y - need < MARGIN + 24) {
      page = doc.addPage(A4);
      y = A4[1] - MARGIN;
    }
  };
  const drawLines = (lines: string[], font: PDFFont, size: number, color = INK, indent = 0, gap = 1.45) => {
    for (const ln of lines) {
      newPageIfNeeded(size * gap);
      page.drawText(ln, { x: MARGIN + indent, y: y - size, size, font, color });
      y -= size * gap;
    }
  };

  // Title block
  drawLines(wrap(sanitize(title), bold, 22, usable), bold, 22);
  page.drawText(sanitize(`JARVIS · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`), {
    x: MARGIN,
    y: y - 9,
    size: 9,
    font: body,
    color: SOFT,
  });
  y -= 18;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 1.2, color: ACCENT });
  y -= 20;

  const strip = (s: string) =>
    sanitize(
      s
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)"),
    );

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      y -= 7;
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const size = h[1].length === 1 ? 17 : h[1].length === 2 ? 14 : 12;
      y -= 6;
      newPageIfNeeded(size * 2);
      drawLines(wrap(strip(h[2]), bold, size, usable), bold, size);
      y -= 2;
      continue;
    }
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    if (bullet) {
      const lines = wrap(strip(bullet[1]), body, 10.5, usable - 16);
      newPageIfNeeded(12);
      page.drawText("•", { x: MARGIN + 4, y: y - 10.5, size: 10.5, font: bold, color: ACCENT });
      drawLines(lines, body, 10.5, INK, 16);
      continue;
    }
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (num) {
      const lines = wrap(strip(num[2]), body, 10.5, usable - 20);
      newPageIfNeeded(12);
      page.drawText(`${num[1]}.`, { x: MARGIN + 2, y: y - 10.5, size: 10.5, font: bold, color: ACCENT });
      drawLines(lines, body, 10.5, INK, 20);
      continue;
    }
    drawLines(wrap(strip(line), body, 10.5, usable), body, 10.5);
  }

  // Page numbers
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`${i + 1} / ${pages.length}`, {
      x: A4[0] / 2 - 10,
      y: MARGIN / 2,
      size: 8,
      font: body,
      color: SOFT,
    });
  });

  return await doc.save();
}
