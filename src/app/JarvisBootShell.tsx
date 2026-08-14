"use client";

export function JarvisBootShell({ phase = "Securing your private workspace" }: { phase?: string }) {
  return (
    <main
      aria-label="Starting Jarvis"
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#05070d] px-6 text-[#f4f2ed]"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,rgba(64,224,255,0.15),transparent_31%),radial-gradient(circle_at_50%_100%,rgba(245,166,35,0.09),transparent_38%)]" />
      <section className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.045] p-7 shadow-[0_28px_100px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:p-9">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-cyan-200/75">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300 shadow-[0_0_16px_rgba(103,232,249,0.9)]" />
            Jarvis
          </span>
          <span className="text-white/35">Private link</span>
        </div>
        <h1 className="mt-8 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Ready when you are.</h1>
        <p aria-live="polite" className="mt-3 text-sm leading-6 text-white/55">{phase}</p>
        <div className="mt-8 grid grid-cols-3 gap-2" aria-hidden>
          <span className="h-1.5 rounded-full bg-cyan-200/75" />
          <span className="h-1.5 rounded-full bg-cyan-200/35" />
          <span className="h-1.5 rounded-full bg-amber/40" />
        </div>
      </section>
    </main>
  );
}
