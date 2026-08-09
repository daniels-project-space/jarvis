"use client";

import { useEffect, useState } from "react";

export default function PairJarvisPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ticket = window.location.hash.slice(1);
    history.replaceState(null, "", "/pair");
    if (!ticket) {
      setFailed(true);
      return;
    }
    void fetch("/api/auth/pair", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    }).then((response) => {
      if (!response.ok) throw new Error("pairing rejected");
      window.location.replace("/");
    }).catch(() => setFailed(true));
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#050506] px-6 text-[#f4f2ed]">
      <section className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#0e0e10] p-8 shadow-2xl">
        <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.22em] text-amber">
          {failed ? "Pairing link unavailable" : "Pairing private workspace"}
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">
          {failed ? "This link is invalid or has expired." : "Connecting Jarvis to this browser…"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/55">
          {failed ? "Request a fresh one-time owner link." : "The pairing code is single-use and never appears in the request URL."}
        </p>
      </section>
    </main>
  );
}
