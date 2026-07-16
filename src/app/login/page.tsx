"use client";

import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (response?.ok) {
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next?.startsWith("/") ? next : "/");
      return;
    }
    setWorking(false);
    setError("Access denied");
  };

  return (
    <main className="relative z-10 flex min-h-dvh items-center justify-center px-5">
      <section className="glass w-full max-w-sm border-white/10 bg-[#050a10]/90 p-7 shadow-[0_24px_100px_rgba(0,0,0,.55)]">
        <div className="mb-8 flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_20px_rgba(0,255,136,.8)]" />
          <div>
            <div className="font-display text-lg tracking-[0.24em] text-ice">JARVIS</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate">private work system</div>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.18em] text-slate">Daniel&apos;s passphrase</span>
            <input
              autoFocus
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full border border-white/12 bg-black/30 px-3 py-2.5 font-mono text-sm text-ice outline-none transition focus:border-cyan/50"
            />
          </label>
          <button
            type="submit"
            disabled={working || !password}
            className="w-full border border-cyan/35 bg-cyan/10 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-cyan transition hover:bg-cyan/15 disabled:opacity-40"
          >
            {working ? "verifying…" : "enter command deck"}
          </button>
          <div aria-live="polite" className="h-4 text-center font-mono text-[9px] uppercase tracking-wider text-amber">
            {error}
          </div>
        </form>
      </section>
    </main>
  );
}
