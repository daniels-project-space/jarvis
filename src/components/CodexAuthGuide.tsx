"use client";

import { useState } from "react";
import Link from "next/link";
import { CodexAuthControl } from "@/components/CodexAuthControl";

const TRIGGER_BILLING_URL =
  "https://cloud.trigger.dev/orgs/daniels-project-space-be0b/settings/billing-limits";

export function CodexAuthGuide() {
  const [connected, setConnected] = useState(false);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#05070d] px-5 py-10 text-ice">
      <section className="w-full max-w-lg rounded-3xl border border-cyan/20 bg-[#08131f]/95 p-6 shadow-[0_24px_90px_rgba(0,0,0,.55)]">
        <div className="hud-label text-cyan">ChatGPT connection</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">
          Reconnect Jarvis’s brain
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate">
          Keep this screen open. Jarvis prepares a one-time OpenAI code, shows
          it here, and automatically detects when sign-in finishes. No API key
          or pasted credential is required.
        </p>

        <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
          <CodexAuthControl
            guideMode
            pollIdle
            onConnected={() => setConnected(true)}
          />
        </div>

        {connected ? (
          <Link
            href="/"
            className="mt-5 inline-flex rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200"
          >
            Connected — return to Jarvis
          </Link>
        ) : (
          <p className="mt-5 text-xs leading-relaxed text-slate">
            If this screen reports a Trigger billing pause, open the{" "}
            <a
              href={TRIGGER_BILLING_URL}
              target="_blank"
              rel="noreferrer"
              className="text-cyan underline decoration-cyan/40 underline-offset-2"
            >
              production billing-limit setting
            </a>
            , unpause it, and retry here.
          </p>
        )}
      </section>
    </main>
  );
}
