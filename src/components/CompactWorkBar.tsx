"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { parseTerminalOutput, type TerminalTone } from "../lib/terminal-output";
import { viewerFetch } from "../lib/viewer-request";
import { supervisorInputValidationError } from "../lib/supervisor-control";
import type {
  CompactJobDetail,
  CompactWorkSnapshot,
  FleetControl,
  FleetEdge,
  FleetMission,
  FleetNode,
  FleetSupervisorAuthority,
} from "../lib/active-work";

const TONE: Record<TerminalTone, string> = {
  neutral: "text-slate-200/90", muted: "text-slate-500", command: "text-sky-300",
  info: "text-blue-300", accent: "text-violet-300", value: "text-amber-300",
  success: "text-emerald-300", warning: "text-amber-300", error: "text-rose-300",
};

const STATE_STYLE: Record<string, string> = {
  queued: "border-slate-500/25 bg-slate-500/10 text-slate-300",
  dependency_held: "border-slate-500/20 bg-black/20 text-slate-500",
  dispatching: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  running: "border-cyan/35 bg-cyan/[0.09] text-cyan",
  reviewing: "border-violet-400/35 bg-violet-400/10 text-violet-300",
  integrating: "border-blue-400/35 bg-blue-400/10 text-blue-300",
  paused: "border-amber/35 bg-amber/[0.08] text-amber",
  done: "border-emerald-400/30 bg-emerald-400/[0.08] text-emerald-300",
  blocked: "border-rose-400/35 bg-rose-400/[0.08] text-rose-300",
  needs_input: "border-amber/50 bg-amber/[0.13] text-amber",
};

const EDGE_STYLE: Record<FleetEdge["readiness"], string> = {
  waiting: "#526274", ready: "#7dd3fc", delivered: "#34d399", blocked: "#fb7185",
};

function agentName(id: string) {
  return ({ paul: "Paul", atlas: "Atlas", iris: "Iris", maya: "Maya", sentry: "Sentry", jarvis: "JARVIS" } as Record<string, string>)[id]
    ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function progressStamp(value: number | null) {
  return value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + "Z" : "not recorded";
}

const FLEET_NODE_STATE_LABEL: Record<FleetNode["state"], string> = {
  queued: "queue",
  dependency_held: "held",
  dispatching: "send",
  running: "run",
  reviewing: "review",
  integrating: "merge",
  paused: "pause",
  done: "done",
  blocked: "block",
  needs_input: "input",
};

export function fleetNodeStateLabel(state: FleetNode["state"]) {
  return FLEET_NODE_STATE_LABEL[state];
}

export function fleetDagLayout(nodes: FleetNode[], edges: FleetEdge[]) {
  // The projection is capped at eight nodes, so a bounded relaxation is both
  // clearer than recursive traversal and safe when an old/malformed plan has a
  // cycle. Sorting is intentional: neither persisted row order nor edge query
  // order should move a node between columns.
  const sortedNodes = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set(sortedNodes.map((node) => node.id));
  const depths = new Map(sortedNodes.map((node) => [node.id, 0]));
  const orderedEdges = edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.id.localeCompare(right.id));
  const depthCap = Math.max(0, sortedNodes.length - 1);
  for (let pass = 0; pass < depthCap; pass += 1) {
    let changed = false;
    for (const edge of orderedEdges) {
      const nextDepth = Math.min(depthCap, (depths.get(edge.source) ?? 0) + 1);
      if (nextDepth > (depths.get(edge.target) ?? 0)) {
        depths.set(edge.target, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxDepth = Math.max(0, ...depths.values());
  const byDepth = new Map<number, FleetNode[]>();
  for (const node of sortedNodes) byDepth.set(depths.get(node.id) ?? 0, [...(byDepth.get(depths.get(node.id) ?? 0) ?? []), node]);
  return sortedNodes.map((node) => {
    const depth = depths.get(node.id) ?? 0;
    const column = byDepth.get(depth) ?? [node];
    const row = column.findIndex((candidate) => candidate.id === node.id);
    return {
      id: node.id,
      depth,
      rowCount: column.length,
      x: 50 + (maxDepth ? (depth / maxDepth) * 500 : 250),
      y: 20 + ((row + 0.5) / column.length) * 220,
    };
  });
}

export function FleetDag({ nodes, edges }: { nodes: FleetNode[]; edges: FleetEdge[] }) {
  const positions = fleetDagLayout(nodes, edges);
  const position = new Map(positions.map((item) => [item.id, item]));
  const maxDepth = Math.max(0, ...positions.map((item) => item.depth));
  const nodeWidth = Math.max(10.75, Math.min(14.5, ((500 / Math.max(1, maxDepth)) - 5) / 6));
  return (
    <div className="rounded-xl border border-white/[0.07] bg-black/20 p-2">
      <section aria-labelledby="fleet-dag-title" aria-describedby="fleet-dag-description">
        <h3 id="fleet-dag-title" className="sr-only">Live fleet dependency graph</h3>
        <p id="fleet-dag-description" className="sr-only">All bounded workstreams and their persisted handoff relationships.</p>
        <div className="relative h-[200px] w-full overflow-hidden sm:h-[220px]">
          <svg viewBox="0 0 600 260" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
            <defs>
              <marker id="fleet-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const source = position.get(edge.source);
              const target = position.get(edge.target);
              if (!source || !target) return null;
              return <path key={edge.id} d={`M ${source.x} ${source.y} C ${source.x + 40} ${source.y}, ${target.x - 40} ${target.y}, ${target.x} ${target.y}`} fill="none" stroke={EDGE_STYLE[edge.readiness]} strokeWidth="2" strokeOpacity=".8" markerEnd="url(#fleet-arrow)" />;
            })}
          </svg>
          <ol aria-label="Live fleet node states" className="absolute inset-0 m-0 list-none p-0">
            {nodes.map((node) => {
              const point = position.get(node.id);
              if (!point) return null;
              const color = node.needsDaniel ? "#fbbf24" : node.state === "done" ? "#34d399" : node.state === "blocked" ? "#fb7185" : "#22d3ee";
              const cardHeight = Math.max(21, Math.min(38, 170 / point.rowCount));
              return <li key={node.id} data-fleet-node aria-label={`${agentName(node.agent)}: ${node.label}, ${node.percent}% ${node.state.replaceAll("_", " ")}`} className="absolute grid -translate-x-1/2 -translate-y-1/2 content-center rounded-md border bg-[#071019]/95 px-0.5 text-center shadow-[0_2px_10px_rgba(0,0,0,.22)]" style={{ left: `${(point.x / 600) * 100}%`, top: `${(point.y / 260) * 100}%`, width: `clamp(41px, ${nodeWidth}%, 76px)`, height: `${cardHeight}px`, borderColor: color, color }}>
                <span className="block whitespace-nowrap text-[8px] font-medium leading-[9px] sm:text-[10px] sm:leading-[11px]">{agentName(node.agent)}</span>
                <span title={node.state.replaceAll("_", " ")} className="block whitespace-nowrap font-mono text-[6px] leading-[7px] tracking-[-0.08em] text-slate-300 sm:text-[8px] sm:leading-[9px] sm:tracking-normal">{node.percent}% {fleetNodeStateLabel(node.state)}</span>
              </li>;
            })}
          </ol>
        </div>
      </section>
      <ol aria-label="Fleet dependency list" className="grid gap-1 text-[9px] text-slate sm:grid-cols-2">
        {nodes.map((node) => {
          const dependencies = edges.filter((edge) => edge.target === node.id);
          return <li key={node.id} className="min-w-0 truncate"><span className="text-ice">{node.label}</span>{dependencies.length ? ` · after ${dependencies.map((edge) => `${edge.source} (${edge.readiness})`).join(", ")}` : " · ready at root"}</li>;
        })}
      </ol>
      <div aria-label="Handoff readiness legend" className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[7px] uppercase tracking-[0.1em] text-slate">
        {(Object.keys(EDGE_STYLE) as FleetEdge["readiness"][]).map((state) => <span key={state}><span aria-hidden="true" className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: EDGE_STYLE[state] }} />{state}</span>)}
      </div>
    </div>
  );
}

function LiveLog({ node, metadata }: { node: FleetNode; metadata?: Record<string, unknown> }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);
  const progress = typeof metadata?.progress === "string" ? metadata.progress : node.progress;
  const log = typeof metadata?.logTail === "string" ? metadata.logTail : "";
  const lines = useMemo(() => parseTerminalOutput(log, progress || "Waiting for meaningful progress…"), [log, progress]);
  useEffect(() => {
    if (ref.current && pinned.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div ref={ref} role="log" aria-label={`${agentName(node.agent)} live work terminal`} aria-live="off"
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        setFollowing(pinned.current);
      }}
      className="scrollbar-thin min-h-[150px] flex-1 overflow-auto rounded-xl border border-white/[0.08] bg-[#05070a]/95 font-mono text-[10px] leading-[1.65]">
      <div className="sticky top-0 z-10 flex items-center border-b border-white/[0.07] bg-[#080b10]/95 px-3 py-2">
        <span className="min-w-0 flex-1 truncate uppercase tracking-[0.14em] text-slate-400">agent://{node.agent}/{node.stage}</span>
        <button type="button" onClick={() => { pinned.current = true; setFollowing(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }} className={following ? "text-cyan/65" : "text-amber"}>{following ? "● follow" : "resume ↓"}</button>
      </div>
      <ol className="py-2">
        {lines.map((line) => <li key={line.id} className="grid grid-cols-[2.5rem_minmax(0,1fr)] px-2">
          <span aria-hidden="true" className="pr-2 text-right text-slate-700">{String(line.number).padStart(2, "0")}</span>
          <span className="whitespace-pre-wrap break-words">{line.spans.map((span, index) => <span key={`${line.id}:${index}`} className={TONE[span.tone]}>{span.text}</span>)}</span>
        </li>)}
      </ol>
    </div>
  );
}

function SubscribedWorker({ node, accessToken }: { node: FleetNode; accessToken: string }) {
  const { run } = useRealtimeRun(node.workerRunId ?? "", { accessToken });
  return <LiveLog node={node} metadata={(run?.metadata ?? {}) as Record<string, unknown>} />;
}

function LazyWorkerLog({ node }: { node: FleetNode }) {
  const streamKey = `${node.jobId}:${node.workerRunId ?? "durable"}`;
  const [stream, setStream] = useState({ key: "", token: "", error: "" });
  useEffect(() => {
    if (!node.workerRunId) return;
    const abort = new AbortController();
    void viewerFetch("/api/work-realtime", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: node.jobId }), signal: abort.signal,
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (abort.signal.aborted) return;
      if (!response.ok || typeof payload?.accessToken !== "string") setStream({ key: streamKey, token: "", error: "Realtime stream is unavailable; showing the last durable progress." });
      else setStream({ key: streamKey, token: payload.accessToken, error: "" });
    }).catch(() => { if (!abort.signal.aborted) setStream({ key: streamKey, token: "", error: "Realtime stream is unavailable; showing the last durable progress." }); });
    return () => abort.abort();
  }, [node.jobId, node.workerRunId, streamKey]);
  const current = stream.key === streamKey ? stream : { token: "", error: "" };
  return <>
    {current.error && <div className="mb-2 rounded-lg border border-amber/20 bg-amber/[0.06] px-2 py-1 text-[9px] text-amber">{current.error}</div>}
    {current.token && node.workerRunId ? <SubscribedWorker node={node} accessToken={current.token} /> : <LiveLog node={node} />}
  </>;
}

type SupervisorControlAction = Extract<
  FleetControl,
  "pause" | "resume" | "cancel" | "steer" | "provide_input"
>;

type ControlTarget = {
  jobId?: string;
  missionId?: string;
  supervisor?: FleetSupervisorAuthority;
};

export type PendingSupervisorRequest = {
  signature: string;
  contentSignature: string;
  requestKey: string;
  request: SupervisorRequestContent;
};

export type SupervisorRequestContent = {
  missionId: string;
  action: SupervisorControlAction;
  expectedInputRevision: number;
  input?: string;
};

const SUPERVISOR_CONTROL_ACTIONS = new Set<FleetControl>([
  "pause",
  "resume",
  "cancel",
  "steer",
  "provide_input",
]);

export function isSupervisorControlAction(
  action: FleetControl,
): action is SupervisorControlAction {
  return SUPERVISOR_CONTROL_ACTIONS.has(action);
}

function supervisorRequestSignature(request: SupervisorRequestContent) {
  return JSON.stringify([
    request.missionId,
    request.action,
    request.expectedInputRevision,
    request.input?.trim() ?? null,
  ]);
}

function supervisorRequestContentSignature(request: SupervisorRequestContent) {
  return JSON.stringify([
    request.missionId,
    request.action,
    request.input?.trim() ?? null,
  ]);
}

export function supervisorRequestIdentity(
  current: PendingSupervisorRequest | null,
  request: SupervisorRequestContent,
  createUuid: () => string = () => crypto.randomUUID(),
  replayAmbiguous = false,
): PendingSupervisorRequest {
  const normalized = {
    ...request,
    ...(request.input === undefined ? {} : { input: request.input.trim() }),
  };
  const signature = supervisorRequestSignature(normalized);
  const contentSignature = supervisorRequestContentSignature(normalized);
  return current?.signature === signature
    || (
      replayAmbiguous
      && current?.contentSignature === contentSignature
    )
    ? current
    : {
      signature,
      contentSignature,
      requestKey: `ui:${createUuid()}`,
      request: normalized,
    };
}

export function preserveSupervisorRequestKey(
  responseStatus: number | null,
): boolean {
  return responseStatus === null || responseStatus === 503;
}

export function supervisorControlPayload(
  request: SupervisorRequestContent,
  requestKey: string,
) {
  const acceptsInput = request.action === "steer"
    || request.action === "provide_input";
  return {
    protocol: "supervisor_v1" as const,
    missionId: request.missionId,
    action: request.action,
    requestKey,
    expectedInputRevision: request.expectedInputRevision,
    ...(acceptsInput ? { input: request.input?.trim() ?? "" } : {}),
  };
}

type SupervisorControlFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SupervisorControlSubmission = {
  ok: boolean;
  error: string | null;
  pendingRequest: PendingSupervisorRequest | null;
  responseStatus: number | null;
  submitted: boolean;
};

export async function submitSupervisorControlRequest({
  current,
  request,
  exactRetry,
  replayAmbiguous = false,
  createUuid,
  fetcher = viewerFetch,
}: {
  current: PendingSupervisorRequest | null;
  request: SupervisorRequestContent;
  exactRetry?: PendingSupervisorRequest;
  replayAmbiguous?: boolean;
  createUuid?: () => string;
  fetcher?: SupervisorControlFetcher;
}): Promise<SupervisorControlSubmission> {
  const effectiveRequest = exactRetry?.request ?? request;
  const inputError = supervisorInputValidationError(effectiveRequest.input);
  if (inputError) {
    return {
      ok: false,
      error: inputError,
      pendingRequest: null,
      responseStatus: 400,
      submitted: false,
    };
  }
  const identity = exactRetry ?? supervisorRequestIdentity(
    current,
    effectiveRequest,
    createUuid,
    replayAmbiguous,
  );
  try {
    const response = await fetcher("/api/work-control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        supervisorControlPayload(identity.request, identity.requestKey),
      ),
    });
    const payload = await response.json().catch(() => ({}));
    const ok = response.ok && payload?.ok === true;
    return {
      ok,
      error: ok
        ? null
        : String(
          payload?.error
            ?? `The controller rejected ${identity.request.action}.`,
        ),
      pendingRequest: preserveSupervisorRequestKey(response.status)
        ? identity
        : null,
      responseStatus: response.status,
      submitted: true,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(
        error instanceof Error
          ? error.message
          : "The authenticated controller could not be reached.",
      ),
      pendingRequest: identity,
      responseStatus: null,
      submitted: true,
    };
  }
}

function Controls({ controls, target, onError }: { controls: FleetControl[]; target: ControlTarget; onError: (value: string) => void }) {
  const [acting, setActing] = useState("");
  const [steering, setSteering] = useState(false);
  const [steeringInput, setSteeringInput] = useState("");
  const [answerInput, setAnswerInput] = useState("");
  const pendingSupervisorRequest = useRef<PendingSupervisorRequest | null>(null);
  const [retryableSupervisorRequest, setRetryableSupervisorRequest] =
    useState<PendingSupervisorRequest | null>(null);
  const clearPendingSupervisorRequest = () => {
    pendingSupervisorRequest.current = null;
    setRetryableSupervisorRequest(null);
  };
  const apply = async (
    action: FleetControl,
    exactRetry?: PendingSupervisorRequest,
  ) => {
    const input = exactRetry?.request.input ?? (action === "steer"
      ? steeringInput.trim()
      : action === "provide_input"
        ? answerInput.trim()
        : undefined);
    if (action === "steer" && !input) { setSteering(true); return; }
    if (action === "provide_input" && !input) {
      onError("Answer Jarvis before sending this control.");
      return;
    }
    const supervisor = target.supervisor;
    const supervisorRequest = supervisor !== undefined
      || exactRetry !== undefined;
    if (supervisorRequest) {
      if (!target.missionId || !isSupervisorControlAction(action)) {
        onError("This control is outside the supervised mission authority.");
        return;
      }
      if (
        exactRetry
        && exactRetry.request.missionId !== target.missionId
      ) {
        onError("This retry belongs to a different supervised mission.");
        return;
      }
      if (!exactRetry && !supervisor) {
        onError("The current supervisor authority has not loaded.");
        return;
      }
      const request = exactRetry?.request ?? {
        missionId: target.missionId,
        action,
        expectedInputRevision: supervisor!.inputRevision,
        ...(input === undefined ? {} : { input }),
      };
      setActing(action);
      onError("");
      try {
        const submission = await submitSupervisorControlRequest({
          current: pendingSupervisorRequest.current,
          request,
          exactRetry,
          replayAmbiguous: retryableSupervisorRequest !== null,
        });
        // A local validation failure and every definitive HTTP response clear
        // any prior ambiguous key. Only a transport/503 outcome retains it.
        pendingSupervisorRequest.current = submission.pendingRequest;
        setRetryableSupervisorRequest(submission.pendingRequest);
        if (!submission.ok) {
          onError(
            submission.error ?? `The controller rejected ${action}.`,
          );
        } else {
          setSteering(false);
          setSteeringInput("");
          setAnswerInput("");
        }
      } finally {
        setActing("");
      }
      return;
    }
    if (action === "provide_input") {
      onError("Supervisor input requires an exact mission authority.");
      return;
    }
    const body = {
      ...target,
      action,
      ...(action === "steer" ? { input } : {}),
    };
    setActing(action);
    onError("");
    try {
      const response = await viewerFetch("/api/work-control", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) onError(String(payload?.error ?? `The controller rejected ${action}.`));
      else {
        setSteering(false);
        setSteeringInput("");
        setAnswerInput("");
      }
    } catch (error) {
      onError(String(error instanceof Error ? error.message : "The authenticated controller could not be reached."));
    } finally { setActing(""); }
  };
  return <div className="space-y-2">
    {retryableSupervisorRequest && <div data-supervisor-retry className="flex items-center gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-2 py-1.5 text-[9px] text-amber"><span className="min-w-0 flex-1">The last control may already be recorded.</span><button type="button" disabled={Boolean(acting)} onClick={() => void apply(retryableSupervisorRequest.request.action, retryableSupervisorRequest)} className="shrink-0 rounded-md border border-amber/30 px-2 py-1 disabled:opacity-40">{acting ? "retrying…" : "retry exact control"}</button></div>}
    {target.supervisor && <div data-supervisor-authority={`${target.supervisor.state}:${target.supervisor.inputRevision}`} className="rounded-lg border border-cyan/15 bg-cyan/[0.035] p-2">
      <div className="font-mono text-[7px] uppercase tracking-[0.1em] text-cyan/60">supervisor · {target.supervisor.state} · revision {target.supervisor.inputRevision}</div>
      {controls.includes("provide_input") && <div data-supervisor-answer className="mt-1.5">
        <div data-supervisor-question className="mb-1 text-[10px] leading-snug text-amber">{target.supervisor.question?.trim() || "Jarvis needs your answer before planning can continue."}</div>
        <div className="flex gap-1"><input aria-label="Answer Jarvis" value={answerInput} disabled={Boolean(acting)} onChange={(event) => { clearPendingSupervisorRequest(); setAnswerInput(event.target.value); }} maxLength={2000} placeholder="Answer this planning question…" className="min-w-0 flex-1 rounded-lg border border-amber/20 bg-black/25 px-2 py-1 text-[10px] text-ice outline-none focus:border-amber/45 disabled:opacity-50" /><button type="button" disabled={!answerInput.trim() || Boolean(acting)} onClick={() => void apply("provide_input")} className="rounded-lg border border-amber/25 px-2 text-[9px] text-amber disabled:opacity-40">{acting === "provide_input" ? "sending…" : "send answer"}</button></div>
      </div>}
    </div>}
    {steering && <div className="flex gap-1"><input aria-label="Steering instruction" value={steeringInput} disabled={Boolean(acting)} onChange={(event) => { clearPendingSupervisorRequest(); setSteeringInput(event.target.value); }} maxLength={2000} placeholder="Adjust the unfinished boundary…" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-2 py-1 text-[10px] text-ice outline-none focus:border-cyan/40 disabled:opacity-50" /><button type="button" disabled={!steeringInput.trim() || Boolean(acting)} onClick={() => void apply("steer")} className="rounded-lg border border-cyan/25 px-2 text-[9px] text-cyan disabled:opacity-40">send steer</button></div>}
    <div className="flex flex-wrap justify-end gap-1">
      {controls.filter((control) => control !== "provide_input").map((control) => <button key={control} type="button" disabled={Boolean(acting)} onClick={() => void apply(control)} className={`rounded-lg border px-2 py-1 text-[8px] uppercase tracking-[0.12em] disabled:opacity-40 ${control === "cancel" || control === "decline" ? "border-rose-400/20 text-rose-300" : "border-white/10 text-slate hover:border-cyan/30 hover:text-cyan"}`}>{acting === control ? "working…" : control.replaceAll("_", " ")}</button>)}
    </div>
  </div>;
}

const SUPERVISED_CHILD_CONTROLS = new Set<FleetControl>([
  "provide_input",
  "approve",
  "decline",
]);

export function workerDetailControls(
  controls: readonly FleetControl[],
  {
    workerMissionId,
    mission,
  }: {
    workerMissionId: string | null;
    mission: Pick<FleetMission, "id" | "mode" | "supervisor">;
  },
): FleetControl[] {
  const supervisedMissionChild = workerMissionId === mission.id
    && (
      mission.mode === "supervised"
      || mission.supervisor?.protocolVersion === 1
    );
  return supervisedMissionChild
    ? controls.filter((control) => SUPERVISED_CHILD_CONTROLS.has(control))
    : [...controls];
}

export function WorkerDetail({
  node,
  onBack,
  workerMissionId,
  mission,
}: {
  node: FleetNode;
  onBack: () => void;
  workerMissionId: string | null;
  mission: Pick<FleetMission, "id" | "mode" | "supervisor">;
}) {
  const [error, setError] = useState("");
  const controls = workerDetailControls(node.controls, {
    workerMissionId,
    mission,
  });
  return <section data-fleet-worker-detail className="flex min-h-0 flex-1 flex-col gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-3">
    <div className="flex min-w-0 items-start gap-2">
      <button type="button" onClick={onBack} className="shrink-0 text-xs text-cyan" aria-label="Back to fleet">←</button>
      <div className="min-w-0 flex-1"><div className="truncate text-xs text-ice">{agentName(node.agent)} · {node.label}</div><div className="mt-0.5 truncate font-mono text-[8px] uppercase tracking-[0.12em] text-slate">{node.model ?? "auto"}/{node.reasoningEffort ?? "default"} · gen {node.generation} · attempt {node.attempt}/{node.maxAttempts}</div>{node.modelReason && <div className="mt-1 text-[9px] leading-snug text-slate">route · {node.modelReason}</div>}</div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[8px] ${STATE_STYLE[node.state]}`}>{node.state.replace("_", " ")}</span>
    </div>
    <div className="grid grid-cols-2 gap-1 text-[9px] text-slate"><div className="truncate">stage · <span className="text-ice">{node.stage}</span></div><div className="truncate">merge · <span className="text-ice">{node.mergeState}</span></div><div className="truncate">handoffs · <span className="text-ice">{node.dependenciesReady}/{node.dependencyCount}</span></div><div className="truncate">runtime · <span className="text-ice">{node.workerRuntime ?? "not assigned"}</span></div><div className="col-span-2 truncate">last meaningful progress · <span className="font-mono text-ice">{progressStamp(node.progressAt)}</span></div></div>
    {node.recoverySummary && <div className="rounded-lg border border-blue-400/15 bg-blue-400/[0.05] px-2 py-1 text-[9px] text-blue-200">recovery · {node.recoverySummary}</div>}
    {node.attentionReason && <div className="rounded-lg border border-amber/20 bg-amber/[0.06] px-2 py-1 text-[9px] text-amber">Needs Daniel · {node.attentionReason}</div>}
    <LazyWorkerLog node={node} />
    {error && <div role="alert" data-control-error className="rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-2 py-1 text-[9px] text-rose-300">{error}</div>}
    <Controls key={`job:${node.jobId}`} controls={controls} target={{ jobId: node.jobId }} onError={setError} />
  </section>;
}

export function FleetCommandCenter({ snapshot, detail, hidden = false, onExpandedChange, onSelectedJobChange, initialExpanded = false }: { snapshot: CompactWorkSnapshot; detail?: CompactJobDetail | null; hidden?: boolean; onExpandedChange?: (expanded: boolean) => void; onSelectedJobChange?: (jobId: string | null) => void; initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [controlError, setControlError] = useState("");
  const active = snapshot.active;
  const fleet = snapshot.fleet;
  // Old Convex and new application releases may overlap briefly. Keep one
  // hierarchy surface during that additive rollout, but never render both the
  // legacy flat nodes and the canonical mission/project tree.
  const hierarchy = snapshot.hierarchy?.length ? snapshot.hierarchy : fleet ? [{
    id: fleet.id,
    label: fleet.goal,
    status: fleet.status,
    phase: fleet.phase,
    projects: [...new Set(fleet.nodes.filter((node) => node.state !== "done").map((node) => node.repository ?? "evidence"))].map((repository) => ({
      id: `legacy:${repository}`,
      canonicalProjectId: repository,
      repository: repository === "evidence" ? null : repository,
      jobs: fleet.nodes.filter((node) => node.state !== "done" && (node.repository ?? "evidence") === repository),
    })),
  }] : [];
  const hierarchyJobs = hierarchy.flatMap((mission) => mission.projects.flatMap((project) => project.jobs));
  const selectedHierarchyMissionId = selectedId
    ? hierarchy.find((mission) => mission.projects.some((project) =>
      project.jobs.some((node) => node.jobId === selectedId)
    ))?.id ?? null
    : null;
  const selectedMissionId = selectedId
    && fleet?.nodes.some((node) => node.jobId === selectedId)
    ? fleet.id
    : selectedHierarchyMissionId;
  const selectedSummary = selectedId ? hierarchyJobs.find((node) => node.jobId === selectedId)
    ?? fleet?.nodes.find((node) => node.jobId === selectedId) ?? null : null;
  const selected = selectedSummary && detail?.jobId === selectedId ? {
    ...selectedSummary,
    jobId: detail.jobId, label: detail.label, agent: detail.agentId ?? selectedSummary.agent,
    repository: detail.repo, status: detail.status, stage: detail.stage, percent: detail.percent,
    progress: detail.progress, progressAt: detail.progressAt, model: detail.model,
    reasoningEffort: detail.reasoningEffort, modelReason: detail.modelReason,
    workerRuntime: detail.workerRuntime,
    workerRunId: detail.workerRunId, generation: detail.generation, attempt: detail.attempt,
    maxAttempts: detail.maxAttempts, integrationState: detail.integrationState ?? selectedSummary.integrationState,
    deliveryStatus: detail.deliveryStatus, startedAt: detail.startedAt,
    recoverySummary: detail.stallReason ?? selectedSummary.recoverySummary,
  } : null;
  const selectJob = (jobId: string | null) => { setSelectedId(jobId); onSelectedJobChange?.(jobId); };
  const setOpen = (next: boolean) => { setExpanded(next); if (!next) selectJob(null); onExpandedChange?.(next); };
  if (!active || !fleet || hidden) return null;
  if (!expanded) return (
    <aside data-fleet-surface="collapsed" data-work-id={active.id} aria-live="polite" className="absolute left-2 top-2 z-30 w-[min(350px,calc(100%-16px))] sm:left-3">
      <button type="button" onClick={() => setOpen(true)} aria-expanded="false" aria-label={`Open live fleet for ${active.label}`} className="glass group grid h-11 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-xl !border-cyan/25 bg-[#071019]/92 px-3 text-left shadow-[0_8px_30px_rgba(0,0,0,.32)] hover:!border-cyan/45">
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${active.needsDaniel ? "bg-amber" : "bg-cyan animate-pulse"}`} />
        <span className="min-w-0"><span className="block truncate text-[11px] text-ice">{active.label}</span><span className="block truncate font-mono text-[8px] uppercase tracking-[0.12em] text-cyan/65">{active.needsDaniel ? "Needs Daniel" : active.stage}</span></span>
        <span className="flex items-center gap-1 font-mono text-[9px] text-cyan"><span>{active.percent}%</span>{active.extraCount > 0 && <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-slate">+{active.extraCount}</span>}</span>
      </button>
    </aside>
  );

  const projectCount = hierarchy.reduce((count, mission) => count + mission.projects.length, 0);
  const planningCount = hierarchyJobs.filter((node) => node.projectionKind === "supervisor_planning").length;
  const activeJobCount = hierarchyJobs.length - planningCount;
  return (
    <aside data-fleet-surface="expanded" aria-label="Live Jarvis fleet" className="materialize glass absolute inset-x-1 bottom-1 z-40 flex h-[min(78vh,680px)] min-h-0 flex-col overflow-hidden rounded-2xl !border-cyan/25 bg-[#071019]/96 p-3 shadow-2xl md:inset-y-2 md:left-2 md:right-auto md:h-auto md:w-[min(760px,62%)]">
      <header className="flex min-w-0 shrink-0 items-start gap-2 border-b border-white/[0.07] pb-2">
        <div className="min-w-0 flex-1"><div className="hud-label text-cyan">live work · immutable groups</div><h2 className="mt-0.5 truncate text-sm text-ice">{fleet.goal}</h2><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-[0.1em] text-slate"><span>{fleet.phase} · {fleet.percent}%</span><span>{hierarchy.length} missions · {projectCount} projects · {activeJobCount} active jobs{planningCount > 0 ? ` · ${planningCount} planning` : ""}</span></div></div>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-[9px] text-slate hover:text-cyan" aria-label="Collapse live fleet">minimize</button>
      </header>
      <div className="mt-2 flex min-h-0 flex-1 gap-2 overflow-hidden">
        {selectedId ? (selected ? <WorkerDetail node={selected} workerMissionId={selectedMissionId} mission={fleet} onBack={() => selectJob(null)} /> : <div data-fleet-detail-loading className="flex flex-1 items-center justify-center text-xs text-cyan">loading exact work detail…</div>) : <div className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-auto pr-0.5">
          <section data-work-hierarchy aria-label="Active mission and project hierarchy" className="space-y-2">
            {hierarchy.map((mission) => <article key={mission.id} data-mission-group={mission.id} className="rounded-xl border border-cyan/15 bg-cyan/[0.025] p-2">
              <header className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><div className="truncate text-[11px] text-ice">{mission.label}</div><div className="truncate font-mono text-[7px] text-cyan/55" title={mission.id}>mission · {mission.id}</div></div><span className="shrink-0 font-mono text-[8px] uppercase text-slate">{mission.phase}</span></header>
              <div className="mt-2 space-y-1.5">{mission.projects.map((project) => <section key={project.id} data-project-group={project.id} className="rounded-lg border border-white/[0.07] bg-black/20 p-1.5">
                <header className="flex min-w-0 items-center gap-2 px-0.5"><div className="min-w-0 flex-1 truncate font-mono text-[8px] text-sky-200">{project.repository ?? "read-only evidence"}</div><span className="shrink-0 font-mono text-[7px] text-slate">{project.canonicalProjectId} · {project.jobs.length}</span></header>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">{project.jobs.map((node) => {
                  const planning = node.projectionKind === "supervisor_planning";
                  const content = <><div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-[10px] text-ice">{agentName(node.agent)} · {node.label}</span><span className="shrink-0 font-mono text-[8px]">{node.percent}%</span></div><div className="mt-1 truncate font-mono text-[8px] uppercase tracking-[0.08em] opacity-75">{node.stage} · {node.model ?? "auto"}/{node.reasoningEffort ?? "default"}</div><div className="mt-1 truncate text-[8px] text-slate" title={node.modelReason ?? (planning ? "Supervisor authority" : "Policy route")}>{planning ? "authority" : "route"} · {node.modelReason ?? (planning ? "durable supervisor state" : "policy default")}</div>{node.needsDaniel && <div className="mt-1 text-[8px] text-amber">Needs Daniel</div>}</>;
                  return planning
                    ? <div key={node.jobId} data-supervisor-planning={node.jobId} role="status" className={`min-w-0 rounded-lg border p-2 text-left ${STATE_STYLE[node.state]}`} aria-label={`${agentName(node.agent)} planning ${node.label}`}>{content}</div>
                    : <button type="button" key={node.jobId} data-active-job={node.jobId} onClick={() => selectJob(node.jobId)} className={`min-w-0 rounded-lg border p-2 text-left transition hover:border-cyan/40 ${STATE_STYLE[node.state]}`} aria-label={`Open ${agentName(node.agent)} detail for ${node.label}`}>{content}</button>;
                })}</div>
              </section>)}</div>
            </article>)}
          </section>
        </div>}
      </div>
      {!selectedId && (fleet.controls.length > 0 || fleet.supervisor) && <footer data-fleet-controls className="mt-2 shrink-0 border-t border-white/[0.07] pt-2">{controlError && <div role="alert" data-control-error className="mb-2 rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-2 py-1 text-[9px] text-rose-300">{controlError}</div>}<Controls key={fleet.id.startsWith("work:") ? `job:${active.id}` : `mission:${fleet.id}`} controls={fleet.controls} target={fleet.id.startsWith("work:") ? { jobId: active.id } : { missionId: fleet.id, supervisor: fleet.supervisor }} onError={setControlError} /></footer>}
    </aside>
  );
}
