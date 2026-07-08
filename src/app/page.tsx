const LAYERS: [string, string][] = [
  ["Brain", "Mastra + Claude Opus"],
  ["Memory", "R2 vault + Convex index"],
  ["Action", "remote-work-hub + Trigger.dev"],
  ["Voice", "Chatterbox (Resemble AI)"],
  ["Face", "Live2D (Next.js)"],
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-8 bg-neutral-950 p-8 font-mono text-neutral-100">
      <div className="text-center">
        <h1 className="text-5xl font-semibold tracking-[0.3em] text-emerald-400">JARVIS</h1>
        <p className="mt-3 text-neutral-400">personal ops assistant · scaffold online</p>
      </div>
      <ul className="w-full max-w-md space-y-2">
        {LAYERS.map(([k, val]) => (
          <li
            key={k}
            className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-4 py-3"
          >
            <span className="text-neutral-300">{k}</span>
            <span className="text-sm text-neutral-500">{val}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-600">daniels-project-space/jarvis</p>
    </main>
  );
}
