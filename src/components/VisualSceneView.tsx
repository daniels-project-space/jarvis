"use client";

import { useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import {
  materializeCapability,
  parseVisualSceneJson,
  type VisualBlock,
  type VisualItem,
  type VisualScene,
  type VisualSeries,
  type VisualTone,
} from "@/lib/visual-scene";

type LiveContext = {
  generatedAt?: number;
  projects?: any[];
  agents?: any[];
  jobs?: any[];
  missions?: any[];
  attention?: any[];
  watches?: any[];
  watchEvents?: any[];
  findings?: any[];
  reminders?: any[];
  business?: Record<string, any>;
};

const COLORS: Record<VisualTone, string> = {
  cyan: "#00ff88",
  green: "#38e6a4",
  amber: "#ffb454",
  red: "#ff647c",
  purple: "#b48cff",
  blue: "#5cc8ff",
  slate: "#7f93ad",
};
const TONE_CLASS: Record<VisualTone, string> = {
  cyan: "text-cyan border-cyan/25 bg-cyan/[0.06]",
  green: "text-emerald-300 border-emerald-300/25 bg-emerald-300/[0.06]",
  amber: "text-amber border-amber/25 bg-amber/[0.06]",
  red: "text-rose-300 border-rose-300/25 bg-rose-300/[0.06]",
  purple: "text-violet-300 border-violet-300/25 bg-violet-300/[0.06]",
  blue: "text-sky-300 border-sky-300/25 bg-sky-300/[0.06]",
  slate: "text-slate border-white/10 bg-white/[0.035]",
};

const number = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const format = (value: unknown) => {
  if (typeof value !== "number") return String(value ?? "—");
  return Math.abs(value) >= 1_000_000
    ? new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : new Intl.NumberFormat("en-GB", { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0 }).format(value);
};
const dateLabel = (value: unknown) => {
  const date = new Date(typeof value === "number" ? value : String(value ?? ""));
  return Number.isNaN(date.getTime())
    ? String(value ?? "")
    : date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};
const toneOf = (item?: VisualItem, fallback: VisualTone = "cyan") => item?.tone ?? fallback;
const valueOf = (item: VisualItem) => number(item.value ?? item.progress);

function Empty({ children = "Nothing to show yet." }: { children?: React.ReactNode }) {
  return <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-white/10 px-4 text-center text-xs text-slate">{children}</div>;
}

function SourceBadge({ block, live }: { block: VisualBlock; live?: LiveContext }) {
  if (!block.source) return <span className="hud-label !text-[8px]">composed</span>;
  const age = live?.generatedAt ? Date.now() - live.generatedAt : 0;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-cyan/15 bg-cyan/[0.04] px-2 py-1 font-mono text-[8px] uppercase tracking-widest text-cyan-dim">
      <span className={`h-1.5 w-1.5 rounded-full ${age > 5 * 60_000 ? "bg-amber" : "bg-cyan scene-live-dot"}`} />
      {age > 5 * 60_000 ? "stale" : "live"} · {block.source.replace("business:", "")}
    </span>
  );
}

function BlockShell({ block, live, focus, children }: { block: VisualBlock; live?: LiveContext; focus?: boolean; children: React.ReactNode }) {
  const span = block.span === "full" ? "lg:col-span-3" : block.span === "two" ? "lg:col-span-2" : "lg:col-span-1";
  const tone = block.tone ?? "cyan";
  return (
    <section
      className={`scene-block tile ${span} min-w-0 overflow-hidden p-4 ${focus ? "scene-focus ring-1 ring-cyan/70" : ""}`}
      aria-label={block.title ?? block.kind}
    >
      <div className="relative z-[1] mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          {block.title && <h2 className="truncate font-display text-sm font-semibold tracking-wide text-ice">{block.title}</h2>}
          {block.subtitle && <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-slate">{block.subtitle}</p>}
        </div>
        <SourceBadge block={block} live={live} />
      </div>
      <div className="relative z-[1]" style={{ "--scene-accent": COLORS[tone] } as React.CSSProperties}>
        {children}
      </div>
    </section>
  );
}

function resolveItems(block: VisualBlock, live?: LiveContext): VisualItem[] {
  if (!block.source || !live) return block.items ?? [];
  if (block.source === "projects")
    return (live.projects ?? []).map((project) => {
      const goal = [...(project.goals ?? [])].sort((left: any, right: any) => number(right.priority) - number(left.priority))[0];
      return {
        id: project.slug,
        label: project.data?.name ?? project.slug,
        value: project.status,
        detail: `${project.data?.purpose ?? project.summary}${goal ? ` · Goal: ${goal.title}${goal.nextAction ? ` · Next: ${goal.nextAction}` : ""}` : ""}`,
        secondary: goal?.title,
        status: goal?.status === "blocked" ? "blocked" : project.status,
        progress: goal?.progress,
        tone: goal?.status === "blocked" || project.status === "ERROR" ? "red" : project.status === "READY" ? "green" : "amber",
      } as VisualItem;
    });
  if (block.source === "agents")
    return (live.agents ?? []).map((agent) => {
      const job = (live.jobs ?? []).find((candidate) => candidate.agentId === agent.slug);
      return {
        id: agent.slug,
        label: agent.name,
        value: agent.status,
        detail: job?.progress ?? job?.label ?? agent.role,
        status: job?.stage ?? agent.status,
        progress: number(job?.percent),
        tone: agent.status === "working" ? "cyan" : agent.status === "blocked" ? "amber" : "green",
      };
    });
  if (block.source === "attention")
    return (live.attention ?? []).map((item) => ({
      id: item.id,
      label: item.title,
      value: Math.round(number(item.impact) * number(item.urgency) * number(item.confidence) / 100),
      detail: item.detail,
      status: item.actionClass,
      progress: Math.round(number(item.impact) * number(item.urgency) * number(item.confidence) / 100),
      tone: item.severity === "critical" || item.severity === "error" ? "red" : item.severity === "warning" ? "amber" : "cyan",
    }));
  if (block.source === "watches")
    return (live.watches ?? []).map((watch) => {
      const product = watch.kind === "product";
      const observed = product
        ? number(watch.lastObservation?.landedPence, NaN) / 100
        : number(watch.lastObservation?.price, NaN);
      const target = product
        ? watch.definition?.targetPence ? `target £${format(number(watch.definition.targetPence) / 100)}` : "meaningful new low"
        : `${watch.definition?.operator} ${format(watch.definition?.threshold)} ${watch.definition?.currency ?? ""}`;
      return {
        id: watch.id,
        label: watch.label,
        value: Number.isFinite(observed) ? `${product ? "£" : ""}${format(observed)}` : "checking",
        secondary: target,
        detail: watch.lastError ? `Source issue: ${watch.lastError}` : `Next check ${dateLabel(watch.nextCheckAt)}`,
        status: watch.kind,
        tone: watch.lastError ? "amber" : "cyan",
      } as VisualItem;
    });
  if (block.source === "findings")
    return (live.findings ?? []).map((finding) => ({
      id: finding.id,
      label: finding.spoken,
      detail: finding.detail,
      status: finding.status,
      tone: finding.important ? "amber" : "cyan",
      start: finding.createdAt,
    }));
  if (block.source === "reminders")
    return (live.reminders ?? []).map((reminder) => ({
      id: reminder.id,
      label: reminder.text,
      detail: dateLabel(reminder.at),
      start: reminder.at,
      tone: reminder.at < Date.now() + 3600_000 ? "amber" : "blue",
    }));
  if (block.source.startsWith("business:")) {
    const domain = block.source.slice("business:".length);
    const snapshot = live.business?.[domain];
    const data = snapshot?.data && typeof snapshot.data === "object" ? snapshot.data : {};
    const metrics = Object.entries(data)
      .filter(([, value]) => typeof value === "number" || typeof value === "string")
      .slice(0, 12)
      .map(([key, value]) => ({ id: key, label: key.replace(/([A-Z])/g, " $1").replace(/_/g, " "), value: value as string | number }));
    return metrics.length ? metrics : snapshot ? [{ label: snapshot.headline, detail: snapshot.detail }] : [];
  }
  return block.items ?? [];
}

function Metrics({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
      {items.slice(0, 12).map((item, index) => (
        <div key={item.id ?? index} className={`scene-metric rounded-xl border p-3 ${TONE_CLASS[toneOf(item, block.tone)]}`}>
          <div className="hud-label !text-[8px] !tracking-[0.18em] opacity-75">{item.label}</div>
          <div className="mt-2 truncate font-display text-2xl font-semibold tabular-nums text-ice">
            {block.prefix}{format(item.value)}{block.suffix}
          </div>
          {(item.secondary !== undefined || item.detail) && <div className="mt-1 truncate text-[10px] opacity-70">{item.secondary ?? item.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function Progress({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const max = block.max ?? 100;
  if (!items.length) return <Empty />;
  return (
    <div className="space-y-3">
      {items.slice(0, 18).map((item, index) => {
        const value = number(item.progress ?? item.value);
        const pct = clamp(((value - (block.min ?? 0)) / Math.max(1, max - (block.min ?? 0))) * 100);
        return (
          <div key={item.id ?? index}>
            <div className="mb-1 flex justify-between gap-3 text-[11px]"><span className="truncate text-ice">{item.label}</span><span className="font-mono text-slate">{format(value)}{block.suffix ?? "%"}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
              <div className="scene-progress h-full rounded-full" style={{ width: `${pct}%`, background: COLORS[toneOf(item, block.tone)] }} />
            </div>
            {item.detail && <div className="mt-1 truncate text-[9px] text-slate">{item.detail}</div>}
          </div>
        );
      })}
    </div>
  );
}

function linePoints(values: number[], width = 620, height = 190, pad = 12) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((value, index) => `${pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2)},${height - pad - ((value - min) / range) * (height - pad * 2)}`).join(" ");
}

function Sparkline({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const rows = items.filter((item) => item.points?.length);
  if (!rows.length) return <Empty>Add numeric <code>points</code> to each series.</Empty>;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.slice(0, 8).map((item, index) => (
        <div key={item.id ?? index} className="rounded-xl border border-white/8 bg-white/[0.025] p-3">
          <div className="flex justify-between text-[10px]"><span className="text-ice">{item.label}</span><span className="font-mono text-cyan">{format(item.value ?? item.points?.at(-1))}</span></div>
          <svg viewBox="0 0 240 64" className="mt-2 h-14 w-full" role="img" aria-label={`${item.label ?? "series"} trend`}>
            <polyline points={linePoints(item.points ?? [], 240, 64, 4)} fill="none" stroke={COLORS[toneOf(item, block.tone)]} strokeWidth="2.5" vectorEffect="non-scaling-stroke" className="scene-line" />
          </svg>
        </div>
      ))}
    </div>
  );
}

function LineChart({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const series: VisualSeries[] = block.series?.length
    ? block.series
    : items.filter((item) => item.points?.length).map((item, index) => ({ id: item.id ?? String(index), label: item.label ?? `Series ${index + 1}`, values: item.points ?? [], tone: item.tone }));
  if (!series.length) return <Empty>Add one or more numeric series.</Empty>;
  const all = series.flatMap((entry) => entry.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (
    <div>
      <svg viewBox="0 0 640 240" className="h-[220px] w-full" role="img" aria-label={`${block.title ?? "Line chart"}. Range ${format(min)} to ${format(max)}`}>
        {[0, 1, 2, 3, 4].map((row) => <line key={row} x1="28" x2="626" y1={20 + row * 48} y2={20 + row * 48} stroke="rgba(255,255,255,.07)" />)}
        {series.map((entry, index) => (
          <polyline key={entry.id ?? index} points={linePoints(entry.values, 640, 240, 28)} fill="none" stroke={COLORS[entry.tone ?? (index ? "blue" : block.tone ?? "cyan")]} strokeWidth="3" vectorEffect="non-scaling-stroke" className="scene-line" />
        ))}
      </svg>
      <div className="flex flex-wrap gap-3 text-[9px] text-slate">{series.map((entry, index) => <span key={entry.id ?? index} className="inline-flex items-center gap-1"><i className="h-1.5 w-4 rounded-full" style={{ background: COLORS[entry.tone ?? (index ? "blue" : block.tone ?? "cyan")] }} />{entry.label}</span>)}</div>
    </div>
  );
}

function BarChart({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const rows = items.slice(0, 18);
  const max = Math.max(1, ...rows.map((item) => Math.abs(valueOf(item))));
  if (!rows.length) return <Empty />;
  return (
    <div className="space-y-2">
      {rows.map((item, index) => <div key={item.id ?? index} className="grid grid-cols-[minmax(70px,1fr)_3fr_auto] items-center gap-2 text-[10px]"><span className="truncate text-slate">{item.label}</span><div className="h-5 overflow-hidden rounded-md bg-white/[0.04]"><div className="scene-bar h-full rounded-md" style={{ width: `${clamp(Math.abs(valueOf(item)) / max * 100)}%`, background: `linear-gradient(90deg,${COLORS[toneOf(item, block.tone)]}55,${COLORS[toneOf(item, block.tone)]})` }} /></div><span className="w-14 text-right font-mono text-ice">{block.prefix}{format(item.value)}{block.suffix}</span></div>)}
    </div>
  );
}

function Donut({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const rows = items.filter((item) => valueOf(item) > 0).slice(0, 10);
  const total = rows.reduce((sum, item) => sum + valueOf(item), 0);
  if (!total) return <Empty />;
  let offset = 0;
  return <div className="grid items-center gap-4 sm:grid-cols-[190px_1fr]"><div className="relative mx-auto h-44 w-44"><svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" role="img" aria-label={`${block.title ?? "Donut"}, total ${format(total)}`}><circle cx="60" cy="60" r="45" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="15" />{rows.map((item, index) => { const length = valueOf(item) / total * 282.74; const node = <circle key={item.id ?? index} cx="60" cy="60" r="45" fill="none" stroke={COLORS[toneOf(item, (["cyan","blue","purple","amber","green"] as VisualTone[])[index % 5])]} strokeWidth="15" strokeDasharray={`${length} ${282.74 - length}`} strokeDashoffset={-offset} className="scene-donut" />; offset += length; return node; })}</svg><div className="absolute inset-0 flex flex-col items-center justify-center"><span className="font-display text-2xl text-ice">{block.prefix}{format(total)}{block.suffix}</span><span className="hud-label !text-[7px]">total</span></div></div><div className="space-y-2">{rows.map((item, index) => <div key={item.id ?? index} className="flex items-center justify-between gap-3 text-[10px]"><span className="flex min-w-0 items-center gap-2 truncate text-slate"><i className="h-2 w-2 rounded-full" style={{ background: COLORS[toneOf(item, (["cyan","blue","purple","amber","green"] as VisualTone[])[index % 5])] }} />{item.label}</span><span className="font-mono text-ice">{Math.round(valueOf(item) / total * 100)}%</span></div>)}</div></div>;
}

function Gauge({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const item = items[0];
  if (!item) return <Empty />;
  const min = block.min ?? 0;
  const max = block.max ?? 100;
  const value = valueOf(item);
  const pct = clamp((value - min) / Math.max(1, max - min));
  return <div className="mx-auto max-w-sm text-center"><svg viewBox="0 0 240 135" className="w-full" role="meter" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}><path d="M 30 115 A 90 90 0 0 1 210 115" fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="18" strokeLinecap="round" pathLength="100"/><path d="M 30 115 A 90 90 0 0 1 210 115" fill="none" stroke={COLORS[toneOf(item, block.tone)]} strokeWidth="18" strokeLinecap="round" pathLength="100" strokeDasharray={`${pct * 100} 100`} className="scene-gauge"/><line x1="120" y1="115" x2={120 + Math.cos(Math.PI - Math.PI * pct) * 70} y2={115 - Math.sin(Math.PI - Math.PI * pct) * 70} stroke="#dbe9f7" strokeWidth="3" strokeLinecap="round" /></svg><div className="-mt-10 font-display text-3xl text-ice">{block.prefix}{format(item.value)}{block.suffix}</div><div className="mt-1 text-xs text-slate">{item.label}</div></div>;
}

function Candles({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const candles = items.filter((item) => [item.open, item.high, item.low, item.close].every((value) => typeof value === "number")).slice(-80);
  if (!candles.length) return <Empty>Add OHLC items to draw a market chart.</Empty>;
  const low = Math.min(...candles.map((item) => item.low!));
  const high = Math.max(...candles.map((item) => item.high!));
  const y = (value: number) => 216 - ((value - low) / Math.max(1e-9, high - low)) * 192;
  const width = 600 / candles.length;
  return <div><svg viewBox="0 0 660 240" className="h-[230px] w-full" role="img" aria-label={`${block.title ?? "Candlestick chart"}. Low ${format(low)}, high ${format(high)}`}><defs><linearGradient id={`candle-bg-${block.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(0,255,136,.08)"/><stop offset="1" stopColor="transparent"/></linearGradient></defs><rect x="0" y="0" width="660" height="240" fill={`url(#candle-bg-${block.id})`} />{[0,1,2,3,4].map((row) => <line key={row} x1="36" x2="646" y1={24 + row * 48} y2={24 + row * 48} stroke="rgba(255,255,255,.06)"/>)}{candles.map((item,index) => { const up = item.close! >= item.open!; const x = 42 + index * width; const color = up ? "#00ff88" : "#ff647c"; return <g key={item.id ?? index} className="scene-candle"><line x1={x} x2={x} y1={y(item.high!)} y2={y(item.low!)} stroke={color}/><rect x={x-Math.max(1,width*.28)} y={Math.min(y(item.open!),y(item.close!))} width={Math.max(2,width*.56)} height={Math.max(1,Math.abs(y(item.open!)-y(item.close!)))} fill={color}/><title>{`${item.label ?? index}: O ${item.open} H ${item.high} L ${item.low} C ${item.close}`}</title></g>})}<text x="6" y="30" fill="#7f93ad" fontSize="10">{format(high)}</text><text x="6" y="220" fill="#7f93ad" fontSize="10">{format(low)}</text></svg><div className="flex justify-between text-[9px] text-slate"><span>{candles[0]?.label}</span><span className="font-mono text-cyan">latest {format(candles.at(-1)?.close)}</span><span>{candles.at(-1)?.label}</span></div></div>;
}

function Heatmap({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  const groups = [...new Set(items.map((item) => item.group ?? "All"))];
  const labels = block.labels?.length ? block.labels : [...new Set(items.map((item) => item.label ?? ""))];
  const max = Math.max(1, ...items.map(valueOf));
  return <div className="overflow-x-auto"><div className="grid min-w-[420px] gap-1" style={{ gridTemplateColumns: `minmax(80px,1fr) repeat(${labels.length},minmax(48px,1fr))` }}><span />{labels.map((label) => <span key={label} className="truncate px-1 text-center text-[8px] text-slate">{label}</span>)}{groups.flatMap((group) => [<span key={`${group}-label`} className="self-center truncate text-[9px] text-slate">{group}</span>, ...labels.map((label) => { const item = items.find((candidate) => (candidate.group ?? "All") === group && (candidate.label ?? "") === label); const pct = item ? valueOf(item) / max : 0; return <div key={`${group}-${label}`} className="flex h-9 items-center justify-center rounded-md border border-white/5 font-mono text-[9px] text-ice" style={{ background: item ? `color-mix(in srgb, ${COLORS[toneOf(item, block.tone)]} ${Math.round(12 + pct * 65)}%, transparent)` : "rgba(255,255,255,.02)" }} title={item?.detail}>{item ? format(item.value) : ""}</div>; })])}</div></div>;
}

function DataTable({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const [sort, setSort] = useState(0);
  const [desc, setDesc] = useState(false);
  const columns = block.columns?.length ? block.columns : ["Name", "Value", "Detail"];
  const rows = block.rows?.length ? block.rows : items.map((item) => [item.label ?? "", item.value ?? "", item.detail ?? item.status ?? ""]);
  const sorted = useMemo(() => [...rows].sort((left, right) => { const a = left[sort] ?? ""; const b = right[sort] ?? ""; const result = typeof a === "number" && typeof b === "number" ? a-b : String(a).localeCompare(String(b), undefined, { numeric: true }); return desc ? -result : result; }), [rows, sort, desc]);
  if (!rows.length) return <Empty />;
  return <div className="scrollbar-thin max-h-[420px] overflow-auto"><table className="w-full border-separate border-spacing-0 text-left text-[10px]"><thead className="sticky top-0 z-10 bg-[#101a2a]"><tr>{columns.map((column,index) => <th key={column} className="border-b border-white/10 px-2 py-2 font-display text-[9px] uppercase tracking-wider text-slate"><button onClick={() => { if (sort === index) setDesc(!desc); else { setSort(index); setDesc(false); } }} className="flex w-full items-center gap-1 text-left hover:text-cyan">{column}{sort===index ? (desc ? " ↓" : " ↑") : ""}</button></th>)}</tr></thead><tbody>{sorted.slice(0,80).map((row,rowIndex) => <tr key={rowIndex} className="hover:bg-cyan/[0.04]">{columns.map((_,cellIndex) => <td key={cellIndex} className="max-w-[280px] truncate border-b border-white/[0.04] px-2 py-2 text-ice/85">{format(row[cellIndex])}</td>)}</tr>)}</tbody></table></div>;
}

function Comparison({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{items.slice(0,9).map((item,index) => <article key={item.id ?? index} className={`rounded-xl border p-3 ${TONE_CLASS[toneOf(item, block.tone)]}`}><div className="flex items-start justify-between gap-2"><h3 className="text-xs font-semibold text-ice">{item.label}</h3>{item.status && <span className="rounded-full border border-current/20 px-2 py-0.5 text-[8px] uppercase tracking-wider">{item.status}</span>}</div>{item.value !== undefined && <div className="mt-3 font-display text-2xl text-ice">{block.prefix}{format(item.value)}{block.suffix}</div>}{item.detail && <p className="mt-2 text-[10px] leading-relaxed text-slate">{item.detail}</p>}{item.url && <a href={item.url} target="_blank" rel="noreferrer" className="mt-3 inline-block text-[10px] text-cyan hover:underline">open ↗</a>}</article>)}</div>;
}

function Timeline({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  return <ol className="relative ml-2 border-l border-cyan/20 pl-5">{items.slice(0,30).map((item,index) => <li key={item.id ?? index} className="relative pb-4 last:pb-0"><i className="absolute -left-[25px] top-1 h-2 w-2 rounded-full ring-4 ring-[#101a2a]" style={{ background: COLORS[toneOf(item, block.tone)] }} /><div className="flex flex-wrap items-baseline justify-between gap-2"><span className="text-[11px] font-medium text-ice">{item.label}</span>{item.start !== undefined && <time className="font-mono text-[8px] text-slate">{dateLabel(item.start)}</time>}</div>{item.detail && <p className="mt-1 text-[10px] leading-relaxed text-slate">{item.detail}</p>}</li>)}</ol>;
}

function Gantt({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const rows = items.filter((item) => item.start !== undefined && item.end !== undefined);
  if (!rows.length) return <Empty>Add start and end dates to milestones.</Empty>;
  const dates = rows.flatMap((item) => [new Date(item.start!).getTime(), new Date(item.end!).getTime()]).filter(Number.isFinite);
  const min = Math.min(...dates); const max = Math.max(...dates); const range = Math.max(86_400_000, max-min);
  return <div className="space-y-2">{rows.slice(0,24).map((item,index) => { const start = new Date(item.start!).getTime(); const end = new Date(item.end!).getTime(); return <div key={item.id ?? index} className="grid grid-cols-[110px_1fr] items-center gap-2"><span className="truncate text-[9px] text-slate" title={item.label}>{item.label}</span><div className="relative h-7 rounded-md bg-white/[0.035]"><div className="scene-gantt absolute top-1 h-5 min-w-1 rounded-md px-1 text-[8px] leading-5 text-[#07100c]" style={{ left: `${(start-min)/range*100}%`, width: `${Math.max(1,(end-start)/range*100)}%`, background: COLORS[toneOf(item, block.tone)] }} title={`${dateLabel(item.start)} – ${dateLabel(item.end)}`}>{item.progress != null ? `${Math.round(item.progress)}%` : ""}</div></div></div>})}<div className="flex justify-between pl-[118px] font-mono text-[8px] text-slate"><span>{dateLabel(min)}</span><span>{dateLabel(max)}</span></div></div>;
}

function Kanban({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  const groups = [...new Set(items.map((item) => item.group ?? item.status ?? "Queue"))].slice(0,6);
  return <div className="grid min-w-[520px] gap-2 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${groups.length},minmax(150px,1fr))` }}>{groups.map((group) => <div key={group} className="rounded-xl border border-white/8 bg-white/[0.02] p-2"><div className="mb-2 flex justify-between text-[9px] uppercase tracking-wider text-slate"><span>{group}</span><span>{items.filter((item) => (item.group ?? item.status ?? "Queue") === group).length}</span></div><div className="space-y-2">{items.filter((item) => (item.group ?? item.status ?? "Queue") === group).map((item,index) => <div key={item.id ?? index} className="rounded-lg border border-white/8 bg-[#0c1524]/80 p-2"><div className="text-[10px] text-ice">{item.label}</div>{item.detail && <div className="mt-1 line-clamp-2 text-[8px] text-slate">{item.detail}</div>}</div>)}</div></div>)}</div>;
}

function Funnel({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const rows = items.slice(0,10); const top = Math.max(1, ...rows.map(valueOf));
  if (!rows.length) return <Empty />;
  return <div className="mx-auto flex max-w-xl flex-col items-center gap-1">{rows.map((item,index) => { const width = Math.max(24,valueOf(item)/top*100); return <div key={item.id ?? index} className="scene-funnel flex h-10 items-center justify-between rounded-md px-3 text-[10px] text-[#07100c]" style={{ width: `${width}%`, background: `linear-gradient(90deg,${COLORS[toneOf(item, block.tone)]}bb,${COLORS[toneOf(item, block.tone)]})` }}><span className="truncate font-semibold">{item.label}</span><span className="font-mono">{format(item.value)}</span></div>})}</div>;
}

function Matrix({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  return <div className="relative aspect-[16/9] min-h-64 overflow-hidden rounded-xl border border-white/8 bg-[linear-gradient(rgba(255,255,255,.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.04)_1px,transparent_1px)] bg-[size:25%_25%]"><span className="absolute left-2 top-2 hud-label !text-[7px]">high impact</span><span className="absolute bottom-2 right-2 hud-label !text-[7px]">high effort</span><div className="absolute left-1/2 top-0 h-full border-l border-white/10"/><div className="absolute left-0 top-1/2 w-full border-t border-white/10"/>{items.slice(0,30).map((item,index) => <button key={item.id ?? index} className={`scene-node absolute max-w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-full border px-2 py-1 text-[9px] shadow-lg ${TONE_CLASS[toneOf(item, block.tone)]}`} style={{ left: `${clamp(number(item.x,50),4,96)}%`, top: `${clamp(100-number(item.y,50),4,96)}%` }} title={item.detail}>{item.label}</button>)}</div>;
}

function Spatial({ block, items, graph = false }: { block: VisualBlock; items: VisualItem[]; graph?: boolean }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  // Start with breathing room around a graph. The old 1:1 crop made even a
  // modest relationship map feel like the camera was pressed against it.
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 0.82 });
  const nodes = (graph ? block.nodes?.length ? block.nodes : items : items).slice(0,80);
  if (!nodes.length) return <Empty />;
  const placed = nodes.map((item,index) => {
    if (graph) { const angle = index / Math.max(1,nodes.length) * Math.PI * 2 - Math.PI/2; const radius = index ? 190 + (index%3)*50 : 0; return { ...item, x: item.x ?? 500 + Math.cos(angle)*radius, y: item.y ?? 300 + Math.sin(angle)*radius }; }
    const lng = item.lng ?? item.x ?? 0; const lat = item.lat ?? item.y ?? 0; return { ...item, x: 500 + lng*3, y: 300-lat*3 };
  });
  const lookup = new Map(placed.map((item) => [item.id, item]));
  return <div className="relative h-[360px] overflow-hidden rounded-xl border border-white/8 bg-[#07111e]"><svg ref={ref} viewBox="0 0 1000 600" className="h-full w-full touch-none select-none" role="img" aria-label={`${graph ? "Graph" : "Map"} with ${placed.length} nodes`} onPointerDown={(event) => { drag.current={x:event.clientX,y:event.clientY,px:camera.x,py:camera.y}; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!drag.current) return; setCamera((current) => ({...current,x:drag.current!.px+(event.clientX-drag.current!.x)/current.scale,y:drag.current!.py+(event.clientY-drag.current!.y)/current.scale})); }} onPointerUp={() => { drag.current=null; }} onWheel={(event) => { event.preventDefault(); setCamera((current) => ({...current,scale:clamp(current.scale*(event.deltaY>0?.9:1.1),.3,3)})); }}><defs><pattern id={`scene-grid-${block.id}`} width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(0,255,136,.055)" strokeWidth="1"/></pattern></defs><rect width="1000" height="600" fill={`url(#scene-grid-${block.id})`}/><g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>{graph && (block.edges ?? []).map((edge,index) => { const from=lookup.get(edge.from); const to=lookup.get(edge.to); if(!from||!to)return null; return <g key={`${edge.from}-${edge.to}-${index}`}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(92,200,255,.45)" strokeWidth="2"/><text x={(number(from.x)+number(to.x))/2} y={(number(from.y)+number(to.y))/2-6} fill="#7f93ad" fontSize="11" textAnchor="middle">{edge.label}</text></g>; })}{!graph && <path d="M0 80 Q180 20 340 110 T700 90 T1000 120 M0 440 Q220 380 420 470 T800 430 T1000 460" fill="none" stroke="rgba(92,200,255,.16)" strokeWidth="3"/>}{placed.map((item,index) => <g key={item.id ?? index} transform={`translate(${item.x} ${item.y})`} className="scene-spatial-node"><circle r={graph ? (index===0?42:28) : 12} fill="#0c1b2b" stroke={COLORS[toneOf(item, block.tone)]} strokeWidth="3"/><text y={graph?4:-18} fill="#dbe9f7" fontSize={graph?13:12} textAnchor="middle" fontWeight="600">{String(item.label ?? "").slice(0,24)}</text>{item.detail && <text y={graph?22:31} fill="#7f93ad" fontSize="9" textAnchor="middle">{item.detail.slice(0,34)}</text>}<title>{`${item.label ?? ""}${item.detail ? `: ${item.detail}`:""}`}</title></g>)}</g></svg><div className="absolute right-2 top-2 flex gap-1"><button onClick={() => setCamera((current)=>({...current,scale:clamp(current.scale*1.2,.3,3)}))} className="glass flex h-8 w-8 items-center justify-center rounded-lg text-cyan" aria-label="Zoom in">+</button><button onClick={() => setCamera((current)=>({...current,scale:clamp(current.scale/1.2,.3,3)}))} className="glass flex h-8 w-8 items-center justify-center rounded-lg text-cyan" aria-label="Zoom out">−</button><button onClick={() => setCamera({x:0,y:0,scale:.82})} className="glass h-8 rounded-lg px-2 text-[9px] text-cyan" aria-label="Fit all">fit</button></div><div className="absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-1 text-[8px] text-slate">drag · wheel/pinch · fit</div></div>;
}

function Gallery({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const images = items.filter((item) => item.image);
  if (!images.length) return <Empty>Add image URLs and alt labels.</Empty>;
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{images.slice(0,18).map((item,index) => <a key={item.id ?? index} href={item.url ?? item.image} target="_blank" rel="noreferrer" className="scene-gallery group relative aspect-[4/3] overflow-hidden rounded-xl border border-white/8"><img src={item.image} alt={item.label ?? "Visual reference"} className="h-full w-full object-cover transition duration-500 group-hover:scale-105"/><div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3 pt-8"><div className="text-[10px] font-medium text-white">{item.label}</div>{item.detail && <div className="mt-0.5 truncate text-[8px] text-white/60">{item.detail}</div>}</div></a>)}</div>;
}

function LinkGrid({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  const links = items.filter((item) => item.url);
  if (!links.length) return <Empty>Add links to create a browsable resource grid.</Empty>;
  return <div className="grid gap-2 sm:grid-cols-2">{links.slice(0,24).map((item,index) => <a key={item.id ?? index} href={item.url} target="_blank" rel="noreferrer" className="group flex min-w-0 items-center gap-3 rounded-xl border border-white/8 bg-white/[0.025] p-3 hover:border-cyan/30 hover:bg-cyan/[0.04]"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${TONE_CLASS[toneOf(item, block.tone)]}`}>{item.image ? <img src={item.image} alt="" className="h-full w-full rounded-lg object-cover"/> : item.icon ?? "↗"}</div><div className="min-w-0"><div className="truncate text-[11px] text-ice group-hover:text-cyan">{item.label ?? item.url}</div>{item.detail && <div className="mt-0.5 truncate text-[9px] text-slate">{item.detail}</div>}</div></a>)}</div>;
}

function Activity({ block, items }: { block: VisualBlock; items: VisualItem[] }) {
  if (!items.length) return <Empty />;
  return <div className="space-y-2">{items.slice(0,30).map((item,index) => <div key={item.id ?? index} className={`scene-activity flex gap-3 rounded-xl border p-3 ${TONE_CLASS[toneOf(item, block.tone)]}`}><i className="mt-1 h-2 w-2 shrink-0 rounded-full bg-current"/><div className="min-w-0 flex-1"><div className="text-[10px] leading-relaxed text-ice">{item.label}</div>{item.detail && <div className="mt-1 line-clamp-2 text-[9px] text-slate">{item.detail}</div>}<div className="mt-1 flex justify-between font-mono text-[8px] opacity-60"><span>{item.status}</span>{item.start !== undefined && <span>{dateLabel(item.start)}</span>}</div></div></div>)}</div>;
}

function AppSnapshot({ block, live, items }: { block: VisualBlock; live?: LiveContext; items: VisualItem[] }) {
  if (!live) return <Empty>Connecting to the live source…</Empty>;
  if (block.source === "agents") return <div className="space-y-3"><Metrics block={{...block,kind:"metrics"}} items={[{label:"available",value:(live.agents??[]).filter((a)=>a.status==="available").length,tone:"green"},{label:"working",value:(live.agents??[]).filter((a)=>a.status==="working").length,tone:"cyan"},{label:"active jobs",value:(live.jobs??[]).length,tone:"blue"},{label:"missions",value:(live.missions??[]).length,tone:"purple"}]}/><Progress block={{...block,kind:"progress",suffix:"%"}} items={items}/>{(live.jobs??[]).length>0 && <Activity block={{...block,kind:"activity"}} items={(live.jobs??[]).slice(0,8).map((job)=>({id:job.id,label:job.label??job.task,detail:job.progress,status:`${job.agentId??"team"} · ${job.stage??job.status}`,progress:job.percent,start:job.startedAt,tone:job.status==="needs_input"?"amber":"cyan"}))}/>}</div>;
  if (block.source === "projects") return <Comparison block={{...block,kind:"comparison"}} items={items}/>;
  if (block.source === "attention") return <Activity block={{...block,kind:"activity"}} items={items}/>;
  if (block.source === "findings" || block.source === "reminders") return <Activity block={{...block,kind:"activity"}} items={items}/>;
  if (block.source === "watches") {
    const signals: VisualItem[] = (live.watchEvents ?? []).map((event) => ({
      id: event.id, label: event.title, detail: event.detail, status: "signal",
      start: event.createdAt, tone: event.glowUntil > Date.now() ? "green" : "cyan",
    }));
    return <div className="space-y-4"><Metrics block={{...block,kind:"metrics"}} items={[{label:"active rules",value:items.length,tone:"cyan"},{label:"open signals",value:signals.length,tone:signals.length?"green":"slate"}]}/>{signals.length>0 && <Activity block={{...block,kind:"activity",title:"Signals"}} items={signals}/>}<Comparison block={{...block,kind:"comparison",title:"Rules"}} items={items}/><div className="text-[9px] leading-relaxed text-slate">Every value carries a source and observation time. Product hunts never buy; asset alerts never trade.</div></div>;
  }
  if (block.source?.startsWith("business:")) {
    const domain = block.source.slice(9);
    const snapshot = live.business?.[domain];
    const data = snapshot?.data ?? {};
    if (!snapshot) return <Empty>No current {domain} snapshot is available.</Empty>;
    const top: VisualItem[] = Array.isArray(data.topEarners)
      ? data.topEarners.map((entry: any, index: number) => ({
          id: String(index), label: entry.name, value: entry.net30d,
          secondary: `${entry.rentals ?? 0} rentals`, tone: "green",
        }))
      : [];
    const uploads: VisualItem[] = Array.isArray(data.uploads)
      ? data.uploads.filter((entry: any) => entry.youtubeVideoId).map((entry: any) => ({
          id: entry.youtubeVideoId, label: entry.title, detail: entry.channelName,
          image: entry.thumbnailUrl, url: `https://www.youtube.com/watch?v=${entry.youtubeVideoId}`,
        }))
      : [];
    const rentalMoney: VisualItem[] = domain === "rental"
      ? [{ label: "this month", value: data.monthEarnings ?? 0, tone: "green" }, { label: "inventory value", value: data.inventoryWorth ?? 0, tone: "blue" }]
      : [];
    const rentalOps: VisualItem[] = domain === "rental"
      ? [{ label: "active rentals", value: data.active ?? 0, tone: "cyan" }, { label: "upcoming", value: data.upcoming ?? 0, tone: "amber" }]
      : [];
    const monthly: VisualItem[] = Array.isArray(data.monthlyRevenue)
      ? [{ label: "monthly revenue", points: data.monthlyRevenue.map((point: any) => number(point.revenue)), value: data.monthlyRevenue.at(-1)?.revenue, tone: "green" }]
      : [];
    const runs: VisualItem[] = domain === "youtube" && Array.isArray(data.activeRuns)
      ? data.activeRuns.map((run: any) => ({
          id: run.runId,
          label: `${run.channelName || "Pipeline"} · ${run.status}`,
          detail: run.stale
            ? `Stale for ${Math.max(1, Math.round(number(run.ageMs) / 3_600_000))}h — needs review`
            : `Running for ${Math.max(1, Math.round(number(run.ageMs) / 60_000))}m`,
          status: run.stale ? "stale" : "active",
          start: run.startedAt,
          tone: run.stale ? "amber" : "cyan",
        }))
      : [];
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-cyan/15 bg-cyan/[0.035] p-3 text-xs leading-relaxed text-ice">{snapshot.headline}</div>
        {domain === "rental" ? (
          <>
            <Metrics block={{ ...block, kind: "metrics", prefix: "£" }} items={rentalMoney} />
            <Metrics block={{ ...block, kind: "metrics" }} items={rentalOps} />
            {monthly.length > 0 && <Sparkline block={{ ...block, kind: "sparkline" }} items={monthly} />}
          </>
        ) : <Metrics block={{ ...block, kind: "metrics" }} items={items} />}
        {top.length > 0 && <BarChart block={{ ...block, kind: "bar", title: "Top earners", prefix: "£" }} items={top} />}
        {uploads.length > 0 && <Gallery block={{ ...block, kind: "gallery", title: "Latest uploads" }} items={uploads} />}
        {runs.length > 0 && <Activity block={{ ...block, kind: "activity", title: "Pipeline status" }} items={runs} />}
        {snapshot.detail && <p className="text-[9px] leading-relaxed text-slate">{snapshot.detail}</p>}
        <div className="font-mono text-[8px] text-slate">observed {dateLabel(snapshot.updatedAt)}</div>
      </div>
    );
  }
  return <Metrics block={{...block,kind:"metrics"}} items={items}/>;
}

function SceneBlock({ block, live, focus }: { block: VisualBlock; live?: LiveContext; focus?: boolean }) {
  const items = resolveItems(block, live);
  let content: React.ReactNode;
  switch (block.kind) {
    case "metrics": content=<Metrics block={block} items={items}/>; break;
    case "progress": content=<Progress block={block} items={items}/>; break;
    case "sparkline": content=<Sparkline block={block} items={items}/>; break;
    case "line": content=<LineChart block={block} items={items}/>; break;
    case "bar": content=<BarChart block={block} items={items}/>; break;
    case "donut": content=<Donut block={block} items={items}/>; break;
    case "gauge": content=<Gauge block={block} items={items}/>; break;
    case "candlestick": content=<Candles block={block} items={items}/>; break;
    case "heatmap": content=<Heatmap block={block} items={items}/>; break;
    case "table": content=<DataTable block={block} items={items}/>; break;
    case "comparison": content=<Comparison block={block} items={items}/>; break;
    case "timeline": content=<Timeline block={block} items={items}/>; break;
    case "gantt": content=<Gantt block={block} items={items}/>; break;
    case "kanban": content=<Kanban block={block} items={items}/>; break;
    case "funnel": content=<Funnel block={block} items={items}/>; break;
    case "matrix": content=<Matrix block={block} items={items}/>; break;
    case "graph": content=<Spatial block={block} items={items} graph/>; break;
    case "gallery": content=<Gallery block={block} items={items}/>; break;
    case "link_grid": content=<LinkGrid block={block} items={items}/>; break;
    case "activity": content=<Activity block={block} items={items}/>; break;
    case "map": content=<Spatial block={block} items={items}/>; break;
    case "app": content=<AppSnapshot block={block} live={live} items={items}/>; break;
  }
  return <BlockShell block={block} live={live} focus={focus}>{content}</BlockShell>;
}

export default function VisualSceneView({ value }: { value: string }) {
  let reference: { creationId?: string; scene?: unknown } = {};
  try { reference=JSON.parse(value); } catch { reference={}; }
  const creation = useJarvisQuery(api.creations.get, reference.creationId ? ({ id: reference.creationId } as any) : "skip") as any;
  const raw = creation?.data ?? (reference.scene ? JSON.stringify(reference.scene) : value);
  const scene: VisualScene = useMemo(() => materializeCapability(parseVisualSceneJson(raw, creation?.title)), [raw, creation?.title]);
  const sources = useMemo(() => [...new Set(scene.blocks.map((block)=>block.source).filter((source): source is string => !!source))].slice(0,12), [scene.blocks]);
  const live = useJarvisQuery(api.visualContext.snapshot, sources.length ? { sources } : "skip") as LiveContext | undefined;
  if (reference.creationId && creation === undefined) return <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-cyan"><span className="h-2 w-2 animate-ping rounded-full bg-cyan"/>assembling visual workspace…</div>;
  return <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_18%_0%,rgba(0,255,136,.07),transparent_28%),radial-gradient(circle_at_90%_12%,rgba(92,200,255,.08),transparent_30%)] p-3 sm:p-5"><header className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><div className="hud-label !text-[8px] !text-cyan-dim">visual intelligence · {scene.blocks.length} modules</div><h1 className="mt-1 font-display text-xl font-semibold tracking-wide text-ice sm:text-2xl">{scene.title}</h1>{scene.subtitle && <p className="mt-1 max-w-3xl text-[10px] leading-relaxed text-slate sm:text-xs">{scene.subtitle}</p>}</div>{scene.capability && <span className="rounded-full border border-cyan/20 bg-cyan/[0.05] px-3 py-1 font-mono text-[8px] uppercase tracking-widest text-cyan">{scene.capability.replace(/_/g," ")}</span>}</header>{scene.blocks.length ? <div className={`grid grid-cols-1 ${scene.layout === "roomy" ? "gap-4" : "gap-3"} lg:grid-cols-3`}>{scene.blocks.map((block)=><SceneBlock key={block.id} block={block} live={live} focus={scene.focusBlockId===block.id}/>)}</div> : <Empty>This workspace is ready for Jarvis to compose into as you talk.</Empty>}<footer className="mt-4 flex justify-between gap-3 font-mono text-[8px] uppercase tracking-widest text-slate/60"><span>stable blocks · live bindings · local camera</span><span>{dateLabel(scene.updatedAt)}</span></footer></div>;
}
