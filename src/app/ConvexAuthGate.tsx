"use client";

import { useConvexAuth } from "convex/react";
import type { ReactNode } from "react";

export function ConvexAuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (isLoading) {
    return <main aria-label="Connecting Jarvis" className="min-h-screen bg-black" />;
  }
  if (!isAuthenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#050506] px-6 text-[#f4f2ed]">
        <section className="w-full max-w-lg rounded-[28px] border border-white/10 bg-white/[0.03] p-7 text-center">
          <h1 className="text-xl font-semibold">Jarvis lost the live connection.</h1>
          <p className="mt-3 text-sm text-white/55">Reconnect to restore messages, voice, and live progress.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-full border border-white/15 px-4 py-2 text-xs text-white/75"
          >
            Reconnect
          </button>
        </section>
      </main>
    );
  }

  return children;
}
