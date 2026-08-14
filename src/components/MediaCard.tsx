"use client";

export type Attachment = {
  type: string;
  value: string;
  title?: string;
  downloadUrl?: string;
};

const WIDGET_ICON: Record<string, string> = {
  weather: "🌤",
  stats: "📊",
  market: "📈",
  timer: "⏱",
  briefing: "📋",
  briefing2: "📋",
  todos: "☑",
  calendar: "📅",
  candles: "📈",
  videos: "📺",
  shop: "🛍",
  doc: "📝",
  ranking: "🏆",
};

const ytId = (s: string) => {
  const match = String(s).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return match ? match[1] : null;
};

// Persistent media card in the stream — click to put it back on the big screen.
export function MediaCard({ a, onShow }: { a: Attachment; onShow: (a: Attachment) => void }) {
  const id = a.type === "video" ? ytId(a.value) : null;
  const ext = id ? `https://www.youtube.com/watch?v=${id}` : a.value;
  let widgetKind = "";
  if (a.type === "widget") {
    try {
      widgetKind = JSON.parse(a.value)?.kind ?? "";
    } catch {
      /* generic icon */
    }
  }
  // Freshly created docs/boards carry their creationId inside `value` (see
  // ui:setPanel calls in src/lib/tools.ts + src/lib/board.ts) — that's enough
  // to offer a one-click download straight from the chat bubble, no need to
  // open the panel first. Docs default to PDF; boards to the editable
  // .excalidraw bundle (PNG/SVG need the live canvas — see BoardView's own
  // "export image" once opened).
  let downloadHref = a.downloadUrl ?? "";
  if (!downloadHref && (a.type === "doc" || a.type === "board")) {
    try {
      const creationId = JSON.parse(a.value)?.creationId;
      if (creationId) downloadHref = `/api/creation-download?id=${encodeURIComponent(creationId)}${a.type === "doc" ? "&format=pdf" : ""}`;
    } catch {
      /* no creationId — no download link */
    }
  }
  return (
    <span className="glass card-lift inline-flex max-w-[88%] items-center gap-2 overflow-hidden rounded-xl p-1.5 pr-2 text-left">
      <button onClick={() => onShow(a)} className="flex min-w-0 items-center gap-2" title="show on screen">
        {id ? (
          <img src={`https://img.youtube.com/vi/${id}/mqdefault.jpg`} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : a.type === "image" ? (
          <img src={a.value} alt="" className="h-12 w-20 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-cyan/10 text-lg">
            {a.type === "widget"
              ? WIDGET_ICON[widgetKind] ?? "🧩"
              : a.type === "url" || a.type === "site"
                ? "🌐"
                : a.type === "code"
                  ? "‹›"
                  : a.type === "pdf"
                    ? "📕"
                    : a.type === "canvas"
                      ? "🕸"
                      : a.type === "scene"
                        ? "✦"
                        : a.type === "trip"
                          ? "🌍"
                          : "📄"}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-xs text-ice">{a.title || a.value}</span>
          <span className="hud-label !text-[8px] !text-cyan-dim">{a.type} · tap to view</span>
        </span>
      </button>
      {(a.type === "url" || a.type === "video" || a.type === "image") && (
        <a href={ext} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-slate hover:text-cyan" title="open in tab">
          ↗
        </a>
      )}
      {downloadHref && (
        <a href={downloadHref} download className="shrink-0 text-xs text-slate hover:text-cyan" title={a.type === "doc" ? "download as PDF" : a.type === "board" ? "download board file" : "download file"}>
          ⬇
        </a>
      )}
    </span>
  );
}
