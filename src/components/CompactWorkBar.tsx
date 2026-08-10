"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { parseTerminalOutput, type TerminalTone } from "../lib/terminal-output";
import { viewerFetch } from "../lib/viewer-request";
import { supervisorInputValidationError } from "../lib/supervisor-control";
import {
  retainedFleetSelection,
  type CompactJobDetail,
  type CompactWorkSnapshot,
  type FleetControl,
  type FleetEdge,
  type FleetMission,
  type FleetNode,
  type FleetSupervisorAuthority,
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

export function workTaskTitle(label: string): string {
  const cleaned = String(label || "Jarvis task")
    .replace(/^(?:jarvis|paul|atlas|iris|maya|sentry)\s*[·:—-]\s*/i, "")
    .replace(/^planning\s*[·:—-]\s*/i, "")
    .replace(/^(?:in|for)\s+(?:daniels-project-space\/)?[a-z0-9._-]+\s*[·:—-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Jarvis task";
}

export function workModelLabel(model: string | null, effort: string | null): string {
  const tier = model ? `${model.charAt(0).toUpperCase()}${model.slice(1)}` : "Auto";
  return `${tier} · ${effort || "adaptive"} effort`;
}

export function workStatusLabel(node: Pick<FleetNode, "state" | "stage" | "needsDaniel" | "attentionKind" | "attentionLabel">): string {
  if (node.attentionLabel) return node.attentionLabel;
  if (node.needsDaniel) return "Your input is needed";
  if (node.attentionKind === "system") return "Waiting for secure worker";
  if (node.attentionKind === "recovery") return "Jarvis is recovering";
  return ({
    queued: "Queued",
    dependency_held: "Waiting for earlier work",
    dispatching: "Preparing the specialist",
    running: "Working",
    reviewing: "Checking the result",
    integrating: "Delivering changes",
    paused: "Paused",
    done: "Complete",
    blocked: "Recovery in progress",
    needs_input: "Your input is needed",
  } as Record<string, string>)[node.state] ?? node.stage.replace(/[_-]+/g, " ");
}

function workPhaseLabel(phase: string, nodes: readonly FleetNode[]): string {
  if (nodes.some((node) => node.needsDaniel)) return phase;
  if (nodes.some((node) => node.attentionKind === "system")) return "Secure worker recovery";
  if (/needs\s+daniel/i.test(phase)) return "Jarvis recovery";
  return phase;
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

function SubscribedWorker({ node, accessToken, runId, onHealthy, onFailed }: { node: FleetNode; accessToken: string; runId: string; onHealthy: () => void; onFailed: () => void }) {
  const { run, error } = useRealtimeRun(runId, { accessToken });
  const metadata = (run?.metadata ?? {}) as Record<string, unknown>;
  const valid = !error && metadata.jobId === node.jobId;
  useEffect(() => {
    if (error) onFailed();
    else if (valid) onHealthy();
  }, [error, onFailed, onHealthy, valid]);
  return <>
    {error && <div className="mb-2 rounded-lg border border-amber/20 bg-amber/[0.06] px-2 py-1 text-[9px] text-amber">Live stream disconnected; reconnecting with durable progress preserved.</div>}
    <LiveLog node={mergeRealtimeWorkNode(node, valid ? metadata : null)} metadata={valid ? metadata : undefined} />
  </>;
}

function LazyWorkerLog({ node }: { node: FleetNode }) {
  const visible = useDocumentVisible();
  const recovery = useRealtimeStreamRecovery(`${node.jobId}:${node.workerRunId ?? "durable"}`);
  const stream = useWorkRealtimeTicket(node, visible, recovery.revision);
  return <>
    {stream.state === "durable" && <div className="mb-2 rounded-lg border border-amber/20 bg-amber/[0.06] px-2 py-1 text-[9px] text-amber">Realtime stream is unavailable; showing the last durable progress.</div>}
    {stream.accessToken && stream.runId ? <SubscribedWorker key={`${stream.runId}:${recovery.revision}`} node={node} accessToken={stream.accessToken} runId={stream.runId} onHealthy={recovery.healthy} onFailed={recovery.failed} /> : <LiveLog node={node} />}
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
      <div className="min-w-0 flex-1"><div className="truncate text-xs text-ice">{workTaskTitle(node.label)}</div><div className="mt-0.5 truncate font-mono text-[8px] uppercase tracking-[0.12em] text-slate">{agentName(node.agent)} · {workModelLabel(node.model, node.reasoningEffort)} · attempt {node.attempt}/{node.maxAttempts}</div>{node.modelReason && <div className="mt-1 text-[9px] leading-snug text-slate">Why this model · {node.modelReason}</div>}</div>
      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[8px] ${STATE_STYLE[node.state]}`}>{node.state.replace("_", " ")}</span>
    </div>
    <div className="grid grid-cols-2 gap-1 text-[9px] text-slate"><div className="truncate">status · <span className="text-ice">{workStatusLabel(node)}</span></div><div className="truncate">merge · <span className="text-ice">{node.mergeState}</span></div><div className="truncate">handoffs · <span className="text-ice">{node.dependenciesReady}/{node.dependencyCount}</span></div><div className="truncate">runtime · <span className="text-ice">{node.workerRuntime ?? "not assigned"}</span></div><div className="col-span-2 truncate">last meaningful progress · <span className="font-mono text-ice">{progressStamp(node.progressAt)}</span></div></div>
    {node.recoverySummary && <div className="rounded-lg border border-blue-400/15 bg-blue-400/[0.05] px-2 py-1 text-[9px] text-blue-200">Recovery · {node.recoverySummary}</div>}
    {node.attentionReason && <div className={`rounded-lg border px-2 py-1 text-[9px] ${node.needsDaniel ? "border-amber/20 bg-amber/[0.06] text-amber" : "border-sky-400/20 bg-sky-400/[0.06] text-sky-200"}`}>{node.attentionLabel ?? (node.needsDaniel ? "Your input is needed" : "Jarvis is recovering")} · {node.attentionReason}</div>}
    <LazyWorkerLog node={node} />
    {error && <div role="alert" data-control-error className="rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-2 py-1 text-[9px] text-rose-300">{error}</div>}
    <Controls key={`job:${node.jobId}`} controls={controls} target={{ jobId: node.jobId }} onError={setError} />
  </section>;
}

function liveWorkNodes(snapshot: CompactWorkSnapshot) {
  const hierarchyNodes = snapshot.hierarchy.flatMap((mission) =>
    mission.projects.flatMap((project) => project.jobs)
  );
  return hierarchyNodes.length ? hierarchyNodes : snapshot.fleet?.nodes ?? [];
}

function isLiveWorkCardNode(node: FleetNode) {
  if (node.state === "done" || node.projectionKind === "supervisor_planning") return false;
  // A deliberate pause is history, not realtime work. Keep it visible only
  // when the pause represents an actual operator or system attention item.
  return node.state !== "paused" || node.needsDaniel || Boolean(node.attentionKind);
}

export function liveWorkSignalNode(snapshot: CompactWorkSnapshot) {
  const nodes = liveWorkNodes(snapshot);
  const candidates = nodes.filter(isLiveWorkCardNode);
  const attentionNode = snapshot.active?.needsDaniel
    ? [...candidates].filter((node) => node.needsDaniel).sort((left, right) =>
        (right.progressAt ?? 0) - (left.progressAt ?? 0)
      )[0] ?? null
    : null;
  const executingStates = new Set<FleetNode["state"]>(["dispatching", "running", "reviewing", "integrating"]);
  const executing = candidates.filter((node) => executingStates.has(node.state));
  const freshestExecuting = [...executing].sort((left, right) =>
    Number(Boolean(right.workerRunId)) - Number(Boolean(left.workerRunId))
      || (right.progressAt ?? 0) - (left.progressAt ?? 0)
  )[0] ?? null;
  const activeNode = candidates.find((node) => node.jobId === snapshot.active?.id) ?? null;
  const freshestFallback = [...candidates].sort((left, right) =>
    (right.progressAt ?? 0) - (left.progressAt ?? 0)
  )[0] ?? null;
  return attentionNode ?? freshestExecuting ?? activeNode ?? freshestFallback;
}

export function liveWorkFreshnessLabel(progressAt: number | null, now: number | null) {
  if (!progressAt) return "waiting for signal";
  if (now === null) return "live signal";
  const ageMs = Math.max(0, now - progressAt);
  if (ageMs < 20_000) return "live now";
  if (ageMs < 60_000) return `updated ${Math.max(1, Math.floor(ageMs / 1_000))}s ago`;
  if (ageMs < 3_600_000) return `updated ${Math.floor(ageMs / 60_000)}m ago`;
  return `updated ${Math.floor(ageMs / 3_600_000)}h ago`;
}

export function mergeRealtimeWorkNode(
  node: FleetNode,
  metadata: Record<string, unknown> | null | undefined,
  observedAt: number | null = null,
) {
  if (!metadata || metadata.jobId !== node.jobId) return node;
  const realtimePercent = typeof metadata.percent === "number" && Number.isFinite(metadata.percent)
    ? Math.max(0, Math.min(100, metadata.percent))
    : node.percent;
  const realtimeStage = typeof metadata.stage === "string" && metadata.stage.trim()
    ? metadata.stage.trim().slice(0, 80)
    : node.stage;
  const realtimeProgress = typeof metadata.progress === "string" && metadata.progress.trim()
    ? metadata.progress.trim().slice(0, 400)
    : node.progress;
  return {
    ...node,
    percent: realtimePercent,
    stage: realtimeStage,
    progress: realtimeProgress,
    progressAt: observedAt ?? node.progressAt,
  };
}

export function realtimeWorkSignalState(
  jobId: string,
  metadata: Record<string, unknown> | null | undefined,
  options: { hasError?: boolean; finished?: boolean } = {},
): "connecting" | "realtime" | "durable" {
  if (options.hasError || metadata?.jobId !== jobId) return "connecting";
  return options.finished ? "durable" : "realtime";
}

type WorkRealtimeTicket = {
  key: string;
  runId: string;
  accessToken: string;
  state: "idle" | "connecting" | "connected" | "durable";
};

const EMPTY_REALTIME_TICKET: WorkRealtimeTicket = { key: "", runId: "", accessToken: "", state: "idle" };
const WORK_REALTIME_TOKEN_REUSE_MS = 48 * 60_000;
const WORK_REALTIME_TOKEN_REFRESH_MS = 50 * 60_000;
const WORK_REALTIME_TOKEN_VALID_MS = 59 * 60_000;
const WORK_REALTIME_RETRY_MS = [2_000, 6_000, 15_000] as const;
const WORK_REALTIME_RECOVERY_MS = 60_000;
const workRealtimeTicketCache = new Map<string, WorkRealtimeTicket & { acquiredAt: number }>();

type WorkRealtimeFetchResult =
  | { kind: "connected"; runId: string; accessToken: string }
  | { kind: "retryable" }
  | { kind: "forbidden" };

type WorkRealtimeFetcher = (input: string, init: RequestInit) => Promise<Response>;

export async function fetchWorkRealtimeTicket(
  jobId: string,
  signal: AbortSignal,
  fetcher: WorkRealtimeFetcher = viewerFetch,
): Promise<WorkRealtimeFetchResult> {
  try {
    const response = await fetcher("/api/work-realtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if ([400, 403].includes(response.status)) return { kind: "forbidden" };
    if (!response.ok || typeof payload?.accessToken !== "string" || typeof payload?.runId !== "string") {
      return { kind: "retryable" };
    }
    return { kind: "connected", runId: payload.runId, accessToken: payload.accessToken };
  } catch {
    return { kind: "retryable" };
  }
}

export function workRealtimeRetryDelay(attempt: number) {
  return WORK_REALTIME_RETRY_MS[attempt] ?? WORK_REALTIME_RECOVERY_MS;
}

export function shouldRemintWorkRealtimeTicket(consecutiveFailures: number) {
  return consecutiveFailures >= WORK_REALTIME_RETRY_MS.length;
}

function rememberWorkRealtimeTicket(key: string, ticket: WorkRealtimeTicket & { acquiredAt: number }) {
  const now = Date.now();
  for (const [cachedKey, cached] of workRealtimeTicketCache) {
    if (now - cached.acquiredAt >= WORK_REALTIME_TOKEN_VALID_MS) workRealtimeTicketCache.delete(cachedKey);
  }
  if (!workRealtimeTicketCache.has(key) && workRealtimeTicketCache.size >= 12) {
    const oldest = [...workRealtimeTicketCache.entries()].sort((left, right) => left[1].acquiredAt - right[1].acquiredAt)[0];
    if (oldest) workRealtimeTicketCache.delete(oldest[0]);
  }
  workRealtimeTicketCache.set(key, ticket);
}

function useDocumentVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const refresh = () => setVisible(document.visibilityState === "visible");
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return visible;
}

function useRealtimeStreamRecovery(key: string) {
  const [revision, setRevision] = useState(0);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const healthy = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!stableTimer.current) {
      stableTimer.current = setTimeout(() => {
        failures.current = 0;
        stableTimer.current = null;
      }, 30_000);
    }
  }, []);
  const failed = useCallback(() => {
    if (timer.current) return;
    if (stableTimer.current) clearTimeout(stableTimer.current);
    stableTimer.current = null;
    const delay = workRealtimeRetryDelay(failures.current);
    failures.current += 1;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (shouldRemintWorkRealtimeTicket(failures.current)) workRealtimeTicketCache.delete(key);
      setRevision((value) => value + 1);
    }, delay);
  }, [key]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (stableTimer.current) clearTimeout(stableTimer.current);
    timer.current = null;
    stableTimer.current = null;
    failures.current = 0;
  }, [key]);
  return { revision, healthy, failed };
}

function useWorkRealtimeTicket(node: Pick<FleetNode, "jobId" | "workerRunId">, enabled: boolean, recoveryRevision = 0) {
  const key = `${node.jobId}:${node.workerRunId ?? "durable"}`;
  const [ticket, setTicket] = useState<WorkRealtimeTicket>(EMPTY_REALTIME_TICKET);
  useEffect(() => {
    if (!enabled || !node.workerRunId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const scheduleRefresh = (delayMs: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void acquire(0, true);
      }, Math.max(1_000, delayMs));
    };
    const acquire = async (attempt: number, force = false): Promise<void> => {
      if (stopped) return;
      const cached = workRealtimeTicketCache.get(key);
      const age = cached ? Date.now() - cached.acquiredAt : Number.POSITIVE_INFINITY;
      if (!force && cached && age < WORK_REALTIME_TOKEN_REUSE_MS) {
        setTicket(cached);
        scheduleRefresh(WORK_REALTIME_TOKEN_REFRESH_MS - age);
        return;
      }
      if (!cached || age >= WORK_REALTIME_TOKEN_VALID_MS) {
        workRealtimeTicketCache.delete(key);
        setTicket({ key, runId: "", accessToken: "", state: "connecting" });
      }
      controller?.abort();
      controller = new AbortController();
      const result = await fetchWorkRealtimeTicket(node.jobId, controller.signal);
      if (stopped || controller.signal.aborted) return;
      if (result.kind === "forbidden") {
        workRealtimeTicketCache.delete(key);
        setTicket({ key, runId: "", accessToken: "", state: "durable" });
        return;
      }
      if (result.kind === "connected") {
        const next = {
          key,
          runId: result.runId,
          accessToken: result.accessToken,
          state: "connected" as const,
          acquiredAt: Date.now(),
        };
        rememberWorkRealtimeTicket(key, next);
        setTicket(next);
        scheduleRefresh(WORK_REALTIME_TOKEN_REFRESH_MS);
        return;
      }
      const retained = workRealtimeTicketCache.get(key);
      const retainedAge = retained ? Date.now() - retained.acquiredAt : Number.POSITIVE_INFINITY;
      if (retained && retainedAge < WORK_REALTIME_TOKEN_VALID_MS) setTicket(retained);
      else setTicket({ key, runId: "", accessToken: "", state: "durable" });
      const delay = workRealtimeRetryDelay(attempt);
      const nextAttempt = attempt < WORK_REALTIME_RETRY_MS.length ? attempt + 1 : attempt;
      timer = setTimeout(() => void acquire(nextAttempt, true), delay);
    };

    void acquire(0);
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, node.jobId, node.workerRunId, recoveryRevision]);
  return enabled && ticket.key === key ? ticket : EMPTY_REALTIME_TICKET;
}

function LiveWorkFreshness({ progressAt, realtime }: { progressAt: number | null; realtime: boolean }) {
  // This is a local display clock, not polling. Convex still pushes every real
  // work update; the timer only tells Daniel how fresh the last signal is.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (realtime) return;
    const refresh = () => setNow(Date.now());
    refresh();
    if (!progressAt) return;
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [progressAt, realtime]);
  if (realtime) return <span aria-hidden="true" data-work-signal-freshness>connected</span>;
  const freshness = liveWorkFreshnessLabel(progressAt, now);
  return <span aria-hidden="true" data-work-signal-freshness>{freshness.replace("waiting for signal", "waiting for checkpoint").replace("live signal", "last checkpoint").replace("live now", "checkpoint now").replace("updated ", "checkpoint ")}</span>;
}

function CompactLiveWorkBubbleView({
  snapshot,
  signalNode,
  realtimeState,
  onOpen,
}: {
  snapshot: CompactWorkSnapshot;
  signalNode: FleetNode | null;
  realtimeState: "durable" | "connecting" | "realtime";
  onOpen: (jobId?: string) => void;
}) {
  const active = snapshot.active!;
  const nodes = liveWorkNodes(snapshot);
  const liveCards = nodes.filter(isLiveWorkCardNode);
  const cards = liveCards.length
    ? liveCards
    : nodes.filter((node) => node.state !== "done" && node.projectionKind === "supervisor_planning");
  const circumference = 100;

  if (!cards.length) return null;

  return (
    <aside
      data-fleet-surface="collapsed"
      data-work-id={active.id}
      data-work-realtime={realtimeState}
      aria-live="off"
      aria-label={`${cards.length || 1} active Jarvis task${cards.length === 1 ? "" : "s"}`}
      className="scrollbar-thin absolute left-2 top-2 z-30 max-h-[42vh] w-[min(360px,calc(100%-16px))] overflow-y-auto pr-0.5 sm:left-3 sm:top-3 sm:max-h-[calc(100vh-96px)]"
    >
      <div className="space-y-1.5">{cards.map((durableNode) => {
        const node = signalNode?.jobId === durableNode.jobId ? signalNode : durableNode;
        const percent = Math.max(0, Math.min(100, node.percent));
        const progress = node.progress.trim() || node.stage;
        const title = workTaskTitle(node.label);
        const status = workStatusLabel(node);
        const personal = node.needsDaniel;
        const system = node.attentionKind === "system" || node.attentionKind === "recovery";
        const ringClass = personal ? "stroke-amber" : system ? "stroke-sky-400" : "stroke-cyan";
        const textClass = personal ? "text-amber" : system ? "text-sky-300" : "text-cyan";
        const meterClass = personal ? "bg-amber" : system ? "bg-sky-400" : "bg-cyan";
        const cardRealtime = signalNode?.jobId === node.jobId ? realtimeState : "durable";
        return <button
          key={node.jobId}
          type="button"
          data-work-card={node.jobId}
          data-work-progress={percent}
          onClick={() => onOpen(node.projectionKind === "supervisor_planning" ? undefined : node.jobId)}
          aria-expanded="false"
          aria-label={`Open ${title}: ${percent}% ${status}. ${progress}`}
          className={`work-progress-button glass group relative grid min-h-[68px] w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-xl bg-[#071019]/94 px-2 py-1.5 pr-2.5 text-left shadow-[0_8px_28px_rgba(0,0,0,.34)] transition-[border-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px hover:shadow-[0_10px_32px_rgba(0,0,0,.4)] motion-reduce:transform-none motion-reduce:transition-none ${
            personal ? "!border-amber/35 hover:!border-amber/60" : system ? "!border-sky-400/30 hover:!border-sky-400/55" : "!border-cyan/25 hover:!border-cyan/50"
          }`}
        >
          <span className="relative grid h-10 w-10 shrink-0 place-items-center" role="progressbar" aria-label={`${title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <svg aria-hidden="true" viewBox="0 0 40 40" className="absolute inset-0 h-full w-full -rotate-90 overflow-visible">
              <circle cx="20" cy="20" r="16" fill="rgba(3,10,16,.82)" stroke="rgba(255,255,255,.09)" strokeWidth="2.5" />
              <circle data-work-progress-ring className={`work-progress-ring ${ringClass}`} cx="20" cy="20" r="16" fill="none" pathLength={circumference} strokeDasharray={circumference} strokeDashoffset={circumference - percent} strokeLinecap="round" strokeWidth="2.5" />
            </svg>
            <span className={`relative font-mono text-[9px] font-semibold ${textClass}`}>{percent}<span className="text-[6px]">%</span></span>
          </span>
          <span className="min-w-0 self-center">
            <span className={`flex items-center gap-1 truncate font-mono text-[7px] uppercase tracking-[0.1em] ${textClass}`}><span>{agentName(node.agent)}</span><span className="text-white/20">·</span><span>{status}</span></span>
            <span className="mt-0.5 block truncate text-[11px] font-medium text-ice" title={node.label}>{title}</span>
            <span key={`${node.jobId}:${node.progressAt ?? 0}:${progress}`} data-work-progress-update className="work-progress-update mt-0.5 block truncate text-[8px] text-slate" title={progress}>{progress}</span>
          </span>
          <span className="flex max-w-[90px] flex-col items-end gap-1" aria-hidden="true">
            <span className="truncate font-mono text-[7px] uppercase tracking-[0.08em] text-slate">{workModelLabel(node.model, node.reasoningEffort)}</span>
            <span className={`font-mono text-[7px] ${textClass}`}>{cardRealtime === "realtime" ? "live" : cardRealtime === "connecting" ? "syncing" : <LiveWorkFreshness progressAt={node.progressAt} realtime={false} />}</span>
            <span className="work-progress-arrow text-[11px] text-cyan/50 transition-transform duration-200 group-hover:translate-x-px motion-reduce:transform-none">›</span>
          </span>
          <span className="absolute inset-x-2 bottom-0 h-px overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true"><span data-work-progress-meter className={`work-progress-meter block h-full rounded-full ${meterClass}`} style={{ width: `${percent}%` }} /></span>
        </button>;
      })}</div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{cards.length} active tasks. Latest progress is shown on each card.</span>
    </aside>
  );
}

function SubscribedLiveWorkBubble({
  snapshot,
  node,
  ticket,
  onHealthy,
  onFailed,
  onOpen,
}: {
  snapshot: CompactWorkSnapshot;
  node: FleetNode;
  ticket: WorkRealtimeTicket;
  onHealthy: () => void;
  onFailed: () => void;
  onOpen: (jobId?: string) => void;
}) {
  const { run, error } = useRealtimeRun(ticket.runId, { accessToken: ticket.accessToken });
  const metadata = (run?.metadata ?? {}) as Record<string, unknown>;
  const realtimeState = realtimeWorkSignalState(node.jobId, metadata, {
    hasError: Boolean(error),
    finished: Boolean(run?.finishedAt),
  });
  const valid = realtimeState !== "connecting";
  useEffect(() => {
    if (error) onFailed();
    else if (valid) onHealthy();
  }, [error, onFailed, onHealthy, valid]);
  const signalNode = mergeRealtimeWorkNode(node, valid ? metadata : null);
  return <CompactLiveWorkBubbleView snapshot={snapshot} signalNode={signalNode} realtimeState={realtimeState} onOpen={onOpen} />;
}

function CompactLiveWorkBubble({ snapshot, onOpen }: { snapshot: CompactWorkSnapshot; onOpen: (jobId?: string) => void }) {
  const signalNode = liveWorkSignalNode(snapshot);
  const visible = useDocumentVisible();
  const streamKey = `${signalNode?.jobId ?? ""}:${signalNode?.workerRunId ?? "durable"}`;
  const recovery = useRealtimeStreamRecovery(streamKey);
  const ticket = useWorkRealtimeTicket(signalNode ?? { jobId: "", workerRunId: null }, visible, recovery.revision);
  if (signalNode && ticket.accessToken && ticket.runId) {
    return <SubscribedLiveWorkBubble key={`${ticket.runId}:${recovery.revision}`} snapshot={snapshot} node={signalNode} ticket={ticket} onHealthy={recovery.healthy} onFailed={recovery.failed} onOpen={onOpen} />;
  }
  return <CompactLiveWorkBubbleView
    snapshot={snapshot}
    signalNode={signalNode}
    realtimeState={ticket.state === "connecting" ? "connecting" : "durable"}
    onOpen={onOpen}
  />;
}

export function FleetCommandCenter({ snapshot, detail, hidden = false, onExpandedChange, onSelectedJobChange, initialExpanded = false }: { snapshot: CompactWorkSnapshot; detail?: CompactJobDetail | null; hidden?: boolean; onExpandedChange?: (expanded: boolean) => void; onSelectedJobChange?: (jobId: string | null) => void; initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const retainedSelectedId = retainedFleetSelection(selectedId, snapshot);
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
  const selectedHierarchyMissionId = retainedSelectedId
    ? hierarchy.find((mission) => mission.projects.some((project) =>
      project.jobs.some((node) => node.jobId === retainedSelectedId)
    ))?.id ?? null
    : null;
  const selectedMissionId = retainedSelectedId
    && fleet?.nodes.some((node) => node.jobId === retainedSelectedId)
    ? fleet.id
    : selectedHierarchyMissionId;
  const selectedSummary = retainedSelectedId ? hierarchyJobs.find((node) => node.jobId === retainedSelectedId)
    ?? fleet?.nodes.find((node) => node.jobId === retainedSelectedId) ?? null : null;
  const selected = selectedSummary && detail?.jobId === retainedSelectedId ? {
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
  useEffect(() => {
    if (!selectedId || retainedSelectedId) return;
    const timer = setTimeout(() => {
      setSelectedId(null);
      onSelectedJobChange?.(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [onSelectedJobChange, retainedSelectedId, selectedId]);
  if (!active || !fleet || hidden) return null;
  if (!expanded) return <CompactLiveWorkBubble snapshot={snapshot} onOpen={(jobId) => { if (jobId) selectJob(jobId); setOpen(true); }} />;

  const projectCount = hierarchy.reduce((count, mission) => count + mission.projects.length, 0);
  const planningCount = hierarchyJobs.filter((node) => node.projectionKind === "supervisor_planning").length;
  const activeJobCount = hierarchyJobs.length - planningCount;
  const fleetPhase = workPhaseLabel(fleet.phase, hierarchyJobs);
  return (
    <aside data-fleet-surface="expanded" aria-label="Live Jarvis fleet" className="materialize glass absolute inset-x-1 bottom-1 z-40 flex h-[min(78vh,680px)] min-h-0 flex-col overflow-hidden rounded-2xl !border-cyan/25 bg-[#071019]/96 p-3 shadow-2xl md:inset-y-2 md:left-2 md:right-auto md:h-auto md:w-[min(760px,62%)]">
      <header className="flex min-w-0 shrink-0 items-start gap-2 border-b border-white/[0.07] pb-2">
        <div className="min-w-0 flex-1"><div className="hud-label text-cyan">Jarvis live work</div><h2 className="mt-0.5 truncate text-sm text-ice">{workTaskTitle(fleet.goal)}</h2><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-[0.1em] text-slate"><span>{fleetPhase} · {fleet.percent}%</span><span>{hierarchy.length} missions · {projectCount} projects · {activeJobCount} active tasks{planningCount > 0 ? ` · ${planningCount} planning` : ""}</span></div></div>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-[9px] text-slate hover:text-cyan" aria-label="Collapse live fleet">minimize</button>
      </header>
      <div className="mt-2 flex min-h-0 flex-1 gap-2 overflow-hidden">
        {retainedSelectedId ? (selected ? <WorkerDetail node={selected} workerMissionId={selectedMissionId} mission={fleet} onBack={() => selectJob(null)} /> : <div data-fleet-detail-loading className="flex flex-1 items-center justify-center text-xs text-cyan">loading exact work detail…</div>) : <div className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-auto pr-0.5">
          <section data-work-hierarchy aria-label="Active mission and project hierarchy" className="space-y-2">
            {hierarchy.map((mission) => <article key={mission.id} data-mission-group={mission.id} className="rounded-xl border border-cyan/15 bg-cyan/[0.025] p-2">
              <header className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><div className="truncate text-[11px] text-ice">{workTaskTitle(mission.label)}</div><div className="truncate font-mono text-[7px] text-cyan/55">Mission progress</div></div><span className="shrink-0 font-mono text-[8px] uppercase text-slate">{workPhaseLabel(mission.phase, mission.projects.flatMap((project) => project.jobs))}</span></header>
              <div className="mt-2 space-y-1.5">{mission.projects.map((project) => <section key={project.id} data-project-group={project.id} className="rounded-lg border border-white/[0.07] bg-black/20 p-1.5">
                <header className="flex min-w-0 items-center gap-2 px-0.5"><div className="min-w-0 flex-1 truncate font-mono text-[8px] text-sky-200">{project.repository?.replace(/^daniels-project-space\//, "") ?? "Read-only evidence"}</div><span className="shrink-0 font-mono text-[7px] text-slate">{project.jobs.length} task{project.jobs.length === 1 ? "" : "s"}</span></header>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">{project.jobs.map((node) => {
                  const planning = node.projectionKind === "supervisor_planning";
                  const content = <><div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-[10px] text-ice">{workTaskTitle(node.label)}</span><span className="shrink-0 font-mono text-[8px]">{node.percent}%</span></div><div className="mt-1 truncate font-mono text-[8px] uppercase tracking-[0.08em] opacity-75">{agentName(node.agent)} · {workStatusLabel(node)}</div><div className="mt-1 truncate text-[8px] text-slate" title={node.modelReason ?? (planning ? "Supervisor authority" : "Policy route")}>{workModelLabel(node.model, node.reasoningEffort)}</div>{node.needsDaniel && <div className="mt-1 text-[8px] text-amber">{node.attentionLabel ?? "Your input is needed"}</div>}{!node.needsDaniel && node.attentionLabel && <div className="mt-1 text-[8px] text-sky-300">{node.attentionLabel}</div>}</>;
                  return planning
                    ? <div key={node.jobId} data-supervisor-planning={node.jobId} role="status" className={`min-w-0 rounded-lg border p-2 text-left ${STATE_STYLE[node.state]}`} aria-label={`${agentName(node.agent)} planning ${node.label}`}>{content}</div>
                    : <button type="button" key={node.jobId} data-active-job={node.jobId} onClick={() => selectJob(node.jobId)} className={`min-w-0 rounded-lg border p-2 text-left transition hover:border-cyan/40 ${STATE_STYLE[node.state]}`} aria-label={`Open ${agentName(node.agent)} detail for ${node.label}`}>{content}</button>;
                })}</div>
              </section>)}</div>
            </article>)}
          </section>
        </div>}
      </div>
      {!retainedSelectedId && (fleet.controls.length > 0 || fleet.supervisor) && <footer data-fleet-controls className="mt-2 shrink-0 border-t border-white/[0.07] pt-2">{controlError && <div role="alert" data-control-error className="mb-2 rounded-lg border border-rose-400/25 bg-rose-400/[0.07] px-2 py-1 text-[9px] text-rose-300">{controlError}</div>}<Controls key={fleet.id.startsWith("work:") ? `job:${active.id}` : `mission:${fleet.id}`} controls={fleet.controls} target={fleet.id.startsWith("work:") ? { jobId: active.id } : { missionId: fleet.id, supervisor: fleet.supervisor }} onError={setControlError} /></footer>}
    </aside>
  );
}
