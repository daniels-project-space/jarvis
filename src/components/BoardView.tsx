"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { clientMutation } from "@/lib/client-mutation";
import "@excalidraw/excalidraw/index.css";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

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

type SemanticFlowData = {
  title: string;
  detail?: string;
  category: string;
  certainty?: string;
  imageUrl?: string;
};

const FLOW_COLORS: Record<string, string> = {
  character: "#f472b6",
  location: "#38bdf8",
  plot: "#fb923c",
  timeline: "#facc15",
  visual: "#c084fc",
  relationship: "#f9a8d4",
  theme: "#a78bfa",
  object: "#34d399",
  question: "#94a3b8",
  note: "#2dd4bf",
};

function SemanticNode({ data, selected }: NodeProps<Node<SemanticFlowData>>) {
  const accent = FLOW_COLORS[data.category] ?? FLOW_COLORS.note;
  return (
    <div
      className={`w-[260px] overflow-hidden rounded-2xl border bg-[#0a1320]/95 shadow-[0_18px_50px_rgba(0,0,0,.38)] backdrop-blur-md transition ${selected ? "scale-[1.02]" : ""}`}
      style={{ borderColor: selected ? accent : `${accent}66`, boxShadow: selected ? `0 0 0 1px ${accent}, 0 18px 50px rgba(0,0,0,.45)` : undefined }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0" style={{ background: accent }} />
      {data.imageUrl && <img src={data.imageUrl} alt="" className="h-28 w-full object-cover" />}
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[8px] font-semibold uppercase tracking-[0.18em]" style={{ color: accent }}>{data.category}</span>
          {data.certainty && data.certainty !== "stated" && (
            <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[7px] uppercase tracking-wider text-slate">{data.certainty}</span>
          )}
        </div>
        <div className="mt-1.5 text-[13px] font-semibold leading-snug text-ice">{data.title}</div>
        {data.detail && <div className="mt-1.5 line-clamp-4 text-[10px] leading-[1.45] text-slate">{data.detail}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0" style={{ background: accent }} />
    </div>
  );
}

const nodeTypes = { semantic: SemanticNode };

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
  const flowApiRef = useRef<ReactFlowInstance<Node<SemanticFlowData>, Edge> | null>(null);
  const appliedTs = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);
  const [viewMode, setViewMode] = useState<"graph" | "canvas">("graph");
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

  const semanticNodes = useMemo(
    () => Object.values(doc?.semanticNodes ?? {}) as Array<{
      id: string;
      category: string;
      title: string;
      detail?: string;
      certainty?: string;
      imageUrl?: string;
      x: number;
      y: number;
    }>,
    [doc?.semanticNodes],
  );
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<Node<SemanticFlowData>>([]);
  const flowEdges = useMemo<Edge[]>(() => (doc?.semanticEdges ?? []).map((edge: any) => ({
    id: String(edge.id),
    source: String(edge.from),
    target: String(edge.to),
    label: edge.label,
    animated: edge.kind === "sequence",
    markerEnd: { type: MarkerType.ArrowClosed, color: edge.kind === "sequence" ? "#facc15" : "#64748b" },
    style: { stroke: edge.kind === "sequence" ? "#facc15" : "#64748b", strokeWidth: edge.kind === "sequence" ? 2.4 : 1.5 },
    labelStyle: { fill: "#cbd5e1", fontSize: 9 },
  })), [doc?.semanticEdges]);

  useEffect(() => {
    setFlowNodes(semanticNodes.map((node) => ({
      id: node.id,
      type: "semantic",
      position: { x: node.x, y: node.y },
      data: {
        title: node.title,
        detail: node.detail,
        category: node.category,
        certainty: node.certainty,
        imageUrl: node.imageUrl,
      },
    })));
    if (doc && semanticNodes.length === 0) setViewMode("canvas");
  }, [doc, semanticNodes, setFlowNodes]);

  const persistFlowLayout = (nodes: Node<SemanticFlowData>[]) => {
    if (!creationId) return;
    void clientMutation("creations:boardLayoutSave", {
      id: creationId,
      nodes: JSON.stringify(nodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y }))),
    }).catch(() => {});
  };

  useEffect(() => {
    if (viewMode !== "graph") return;
    apiRef.current = null;
    setReady(false);
  }, [viewMode]);

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
    if (viewMode === "graph") {
      void flowApiRef.current?.fitView({ padding: 0.18, minZoom: 0.12, maxZoom: 1.05, duration: animate ? 420 : 0 });
      return;
    }
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
    if (viewMode === "graph") {
      const target = flowNodes.find((node) => String(node.data.title ?? "").toLowerCase().includes(title.toLowerCase()));
      if (target) void flowApiRef.current?.setCenter(target.position.x + 130, target.position.y + 90, { zoom: 1, duration: 380 });
      return;
    }
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

  const categoryCounts = semanticNodes.reduce<Record<string, number>>((counts, node) => {
    const category = String(node.category ?? "note");
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, {});
  const latestNodeIds = new Set<string>((doc.sourceLog?.at(-1)?.nodeIds ?? []).map(String));
  const latestConcepts = (latestNodeIds.size ? semanticNodes.filter((node) => latestNodeIds.has(String(node.id))) : semanticNodes).slice(0, 10);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden" style={{ colorScheme: "dark" }}>
      {viewMode === "canvas" ? <Excalidraw
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
      /> : (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onFlowNodesChange}
          onInit={(instance) => { flowApiRef.current = instance; }}
          onNodeDragStop={(_, dragged) => persistFlowLayout(flowNodes.map((node) => node.id === dragged.id ? { ...node, position: dragged.position } : node))}
          onNodeDoubleClick={(_, node) => {
            setViewMode("canvas");
            window.setTimeout(() => focusConcept(String(node.data.title ?? "")), 280);
          }}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.12, maxZoom: 1.05 }}
          minZoom={0.06}
          maxZoom={1.8}
          className="bg-[radial-gradient(circle_at_50%_42%,rgba(30,122,166,.1),transparent_45%),#050b12]"
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#183047" gap={28} size={1} />
          <MiniMap
            nodeColor={(node) => FLOW_COLORS[String(node.data?.category ?? "note")] ?? FLOW_COLORS.note}
            maskColor="rgba(3,8,14,.72)"
            className="!border !border-white/10 !bg-[#071019]"
          />
          <Controls className="!overflow-hidden !rounded-xl !border !border-white/10 !bg-[#071019] !shadow-xl" />
        </ReactFlow>
      )}
      <div className={`pointer-events-none absolute left-3 right-3 z-20 rounded-xl border border-cyan/20 bg-[#071019]/90 px-3 py-2 shadow-[0_14px_42px_rgba(0,0,0,0.35)] backdrop-blur-md ${viewMode === "canvas" ? "top-14" : "top-3"}`}>
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
          <span className="pointer-events-auto ml-auto flex rounded-lg border border-white/10 bg-black/20 p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("graph")}
              className={`rounded-md px-2 py-1 text-[9px] uppercase tracking-[0.12em] transition ${viewMode === "graph" ? "bg-cyan/15 text-cyan" : "text-slate hover:text-ice"}`}
            >
              semantic map
            </button>
            <button
              type="button"
              onClick={() => setViewMode("canvas")}
              className={`rounded-md px-2 py-1 text-[9px] uppercase tracking-[0.12em] transition ${viewMode === "canvas" ? "bg-cyan/15 text-cyan" : "text-slate hover:text-ice"}`}
            >
              drawing
            </button>
          </span>
          <button
            type="button"
            onClick={() => fitOverview(true)}
            className="pointer-events-auto rounded-md border border-cyan/25 px-2 py-1 text-[9px] uppercase tracking-[0.14em] text-cyan transition hover:border-cyan/60 hover:bg-cyan/10"
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
