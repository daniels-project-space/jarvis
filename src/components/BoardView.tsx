"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { clientMutation } from "@/lib/client-mutation";
import "@excalidraw/excalidraw/index.css";

// JARVIS's infinite canvas — Excalidraw (MIT) rendering a board creation.
// The brain queues high-level ops (see src/lib/board.ts); this view applies
// them LIVE into the scene, and Daniel's own edits persist back via
// creations:boardSave (which never clobbers ops queued mid-save).

const Excalidraw = dynamic(() => import("@excalidraw/excalidraw").then((m) => m.Excalidraw), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate">
      <span className="mr-2 h-2 w-2 animate-ping rounded-full bg-cyan" /> loading canvas…
    </div>
  ),
});

const fileIdFor = (url: string) => "f" + Math.abs(url.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);

async function urlToDataURL(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export default function BoardView({ value }: { value: string }) {
  let creationId = "";
  try {
    creationId = JSON.parse(value)?.creationId ?? "";
  } catch {
    /* noop */
  }
  const row = useJarvisQuery(api.creations.get, creationId ? { id: creationId as never } : "skip") as { data?: string } | null | undefined;
  const boardSave = (args: Record<string, unknown>) => clientMutation("creations:boardSave", args);
  const apiRef = useRef<any>(null);
  const appliedTs = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const initialLoaded = useRef(false);
  const overviewFitDone = useRef(false);

  const doc = useMemo(() => {
    try {
      return row?.data ? JSON.parse(row.data) : null;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.data]);

  const persist = async () => {
    const ex = apiRef.current;
    if (!ex || !creationId) return;
    const elements = ex.getSceneElements();
    const files = ex.getFiles() ?? {};
    const urls: Record<string, string> = {};
    for (const el of elements) if (el.type === "image" && el.fileId && (files[el.fileId] as any)?.__url) urls[el.fileId] = (files[el.fileId] as any).__url;
    // keep known urls from the doc too (files added earlier sessions)
    for (const [k, v] of Object.entries(doc?.imageUrls ?? {})) if (!urls[k]) urls[k] = v as string;
    await boardSave({
      id: creationId as never,
      elements: JSON.stringify(elements),
      imageUrls: JSON.stringify(urls),
      appliedUpTo: appliedTs.current,
    }).catch(() => {});
  };

  const fitOverview = (animate = true) => {
    const ex = apiRef.current;
    if (!ex) return;
    const elements = ex.getSceneElements();
    if (!elements.length) return;
    ex.scrollToContent(elements, {
      fitToViewport: true,
      viewportZoomFactor: 0.72,
      minZoom: 0.08,
      maxZoom: 1,
      animate,
      duration: animate ? 420 : 0,
    });
  };

  const focusConcept = (title: string) => {
    const ex = apiRef.current;
    if (!ex || !title) return;
    const query = title.toLowerCase();
    const elements = ex.getSceneElements();
    const direct = elements.filter((element: any) => String(element.text ?? "").toLowerCase().includes(query));
    const ids = new Set(direct.flatMap((element: any) => [element.id, element.containerId].filter(Boolean)));
    const targets = elements.filter((element: any) => ids.has(element.id) || ids.has(element.containerId));
    if (!targets.length) return;
    ex.scrollToContent(targets, {
      fitToViewport: true,
      viewportZoomFactor: 0.52,
      minZoom: 0.5,
      maxZoom: 0.9,
      animate: true,
      duration: 380,
    });
  };

  // Apply queued brain ops + restore images whenever the doc changes.
  useEffect(() => {
    const ex = apiRef.current;
    if (!ex || !doc || !ready) return;
    let cancelled = false;
    (async () => {
      const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
      // restore image files for elements loaded from persistence
      for (const [fileId, url] of Object.entries<string>(doc.imageUrls ?? {})) {
        if (ex.getFiles()?.[fileId]) continue;
        const dataURL = await urlToDataURL(url);
        if (dataURL && !cancelled)
          ex.addFiles([{ id: fileId, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")) || "image/png", created: Date.now(), __url: url } as any]);
      }
      const ops = (doc.pendingOps ?? []).filter((op: any) => (op.ts ?? 0) > appliedTs.current);
      if (!ops.length) return;
      const skeletons: any[] = [];
      const skeletonFocus: (string | undefined)[] = [];
      const latestFocusBatch = [...ops].reverse().find((op: any) => op.focusBatch)?.focusBatch as string | undefined;
      for (const op of ops) {
        // edit/delete existing items by fuzzy text match — "fix what I asked"
        if (op.kind === "edit" || op.kind === "delete") {
          const q = String(op.match ?? "").toLowerCase();
          const els = ex.getSceneElements();
          const hitIds = new Set<string>();
          for (const el of els) {
            const t = String((el as any).text ?? "").toLowerCase();
            if (q && t && t.includes(q)) {
              hitIds.add(el.id);
              if ((el as any).containerId) hitIds.add((el as any).containerId);
            }
          }
          if (hitIds.size) {
            if (op.kind === "delete") {
              ex.updateScene({ elements: els.filter((el: any) => !hitIds.has(el.id) && !hitIds.has(el.containerId)) });
            } else if (op.text) {
              ex.updateScene({
                elements: els.map((el: any) =>
                  hitIds.has(el.id) && el.type === "text" ? { ...el, text: op.text, originalText: op.text, version: (el.version ?? 0) + 1 } : el,
                ),
              });
            }
          }
          appliedTs.current = Math.max(appliedTs.current, op.ts ?? 0);
          continue;
        }
        if (op.kind === "skeleton") {
          skeletons.push(op.skel);
          skeletonFocus.push(op.focusBatch);
        }
        else if (op.kind === "image" && op.url) {
          const fileId = fileIdFor(op.url);
          if (!ex.getFiles()?.[fileId]) {
            const dataURL = await urlToDataURL(op.url);
            if (dataURL && !cancelled)
              ex.addFiles([{ id: fileId, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")) || "image/png", created: Date.now(), __url: op.url } as any]);
          }
          skeletons.push({ type: "image", x: op.x, y: op.y, width: op.w, height: op.h, fileId, link: op.link });
          skeletonFocus.push(op.focusBatch);
        }
        appliedTs.current = Math.max(appliedTs.current, op.ts ?? 0);
      }
      if (cancelled) return;
      if (skeletons.length) {
        const fresh = convertToExcalidrawElements(skeletons, { regenerateIds: true });
        ex.updateScene({ elements: [...ex.getSceneElements(), ...fresh] });
        // Frame the entire semantic thought, not the first sticky note. Keeping
        // content to ~64% of the viewport gives enough surrounding context to
        // see its category and connected nodes without a manual zoom-out.
        const focus = latestFocusBatch ? fresh.filter((_, index) => skeletonFocus[index] === latestFocusBatch) : fresh;
        ex.scrollToContent(focus.length ? focus : fresh, {
          fitToViewport: true,
          viewportZoomFactor: 0.64,
          minZoom: 0.12,
          maxZoom: 1.15,
          animate: true,
          duration: 460,
        });
      }
      void persist(); // also clears applied edit/delete ops from the queue
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, ready]);

  if (!doc)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate">
        <span className="mr-2 h-2 w-2 animate-ping rounded-full bg-cyan" /> loading board…
      </div>
    );

  const semanticNodes = Object.values(doc.semanticNodes ?? {}) as { id?: string; category?: string; title?: string; detail?: string }[];
  const categoryCounts = semanticNodes.reduce<Record<string, number>>((counts, node) => {
    const category = String(node.category ?? "note");
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, {});
  const latestNodeIds = new Set<string>((doc.sourceLog?.at(-1)?.nodeIds ?? []).map(String));
  const latestConcepts = (latestNodeIds.size ? semanticNodes.filter((node) => latestNodeIds.has(String(node.id))) : semanticNodes).slice(0, 10);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" style={{ colorScheme: "dark" }}>
      <Excalidraw
        theme="dark"
        excalidrawAPI={(ex: any) => {
          apiRef.current = ex;
          setReady(true);
          if (!overviewFitDone.current && (doc.elements?.length ?? 0) > 0) {
            overviewFitDone.current = true;
            window.setTimeout(() => fitOverview(false), 60);
          }
        }}
        initialData={{
          elements: initialLoaded.current ? undefined : doc.elements ?? [],
          // NOTE: dark theme applies an invert filter — give it a LIGHT canvas
          // colour so the rendered result is the dark cockpit tone.
          appState: { viewBackgroundColor: "#eef4fb", currentItemFontFamily: 1 },
          scrollToContent: true,
        }}
        onChange={() => {
          initialLoaded.current = true;
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => void persist(), 1500);
        }}
        UIOptions={{ canvasActions: { toggleTheme: false, saveToActiveFile: false, loadScene: false, export: { saveFileToDisk: true } } }}
      />
      <div className="pointer-events-none absolute left-3 right-3 top-14 z-20 rounded-xl border border-cyan/20 bg-[#071019]/90 px-3 py-2 shadow-[0_14px_42px_rgba(0,0,0,0.35)] backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="min-w-0">
            <div className="max-w-[280px] truncate text-[11px] font-semibold uppercase tracking-[0.15em] text-ice">{doc.title}</div>
            <div className="mt-0.5 text-[9px] uppercase tracking-[0.14em] text-slate">
              {semanticNodes.length ? `${semanticNodes.length} concepts · ${doc.semanticEdges?.length ?? 0} links` : "live spatial workspace"}
            </div>
          </div>
          {Object.entries(categoryCounts).map(([category, count]) => (
            <span key={category} className="rounded-full border border-white/10 bg-white/[0.035] px-2 py-0.5 text-[8px] uppercase tracking-[0.12em] text-cyan-dim">
              {category} {count}
            </span>
          ))}
          <button
            type="button"
            onClick={() => fitOverview(true)}
            className="pointer-events-auto ml-auto rounded-md border border-cyan/25 px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-cyan transition hover:border-cyan/60 hover:bg-cyan/10"
          >
            fit overview
          </button>
        </div>
        {latestConcepts.length > 0 && (
          <div className="scrollbar-thin pointer-events-auto mt-2 flex gap-2 overflow-x-auto pb-1" aria-label="Latest extracted concepts">
            {latestConcepts.map((node) => (
              <button
                key={node.id ?? `${node.category}-${node.title}`}
                type="button"
                onClick={() => focusConcept(String(node.title ?? ""))}
                className="group min-w-[150px] max-w-[190px] flex-1 rounded-lg border border-white/10 bg-white/[0.035] px-2.5 py-2 text-left transition hover:border-cyan/45 hover:bg-cyan/[0.07]"
                title={`Focus ${node.title ?? "concept"} on the editable canvas`}
              >
                <span className="block text-[7px] font-semibold uppercase tracking-[0.16em] text-cyan-dim">{node.category ?? "note"}</span>
                <span className="mt-1 block truncate text-[10px] font-medium text-ice group-hover:text-cyan">{node.title}</span>
                {node.detail && <span className="mt-0.5 line-clamp-2 block text-[8px] leading-3 text-slate">{node.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
