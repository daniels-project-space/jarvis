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
        if (op.kind === "skeleton") skeletons.push(op.skel);
        else if (op.kind === "image" && op.url) {
          const fileId = fileIdFor(op.url);
          if (!ex.getFiles()?.[fileId]) {
            const dataURL = await urlToDataURL(op.url);
            if (dataURL && !cancelled)
              ex.addFiles([{ id: fileId, dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")) || "image/png", created: Date.now(), __url: op.url } as any]);
          }
          skeletons.push({ type: "image", x: op.x, y: op.y, width: op.w, height: op.h, fileId, link: op.link });
        }
        appliedTs.current = Math.max(appliedTs.current, op.ts ?? 0);
      }
      if (cancelled) return;
      if (skeletons.length) {
        const fresh = convertToExcalidrawElements(skeletons, { regenerateIds: true });
        ex.updateScene({ elements: [...ex.getSceneElements(), ...fresh] });
        ex.scrollToContent(fresh, { fitToViewport: false, animate: true });
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

  return (
    <div className="min-h-0 flex-1" style={{ colorScheme: "dark" }}>
      <Excalidraw
        theme="dark"
        excalidrawAPI={(ex: any) => {
          apiRef.current = ex;
          setReady(true);
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
        UIOptions={{ canvasActions: { toggleTheme: false, saveToActiveFile: false, loadScene: false, export: false } }}
      />
    </div>
  );
}
