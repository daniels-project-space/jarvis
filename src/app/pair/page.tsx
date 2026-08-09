"use client";

import { useEffect, useRef, useState } from "react";
import { ownerPairingTicketFromLocation } from "@/lib/owner-pairing-link";

export default function PairJarvisPage() {
  const [status, setStatus] = useState<"pairing" | "unavailable" | "invalid" | "storage">("pairing");
  const [attempt, setAttempt] = useState(0);
  const ticketRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const incomingTicket = ownerPairingTicketFromLocation(window.location.hash, window.location.search);
    if (incomingTicket) {
      ticketRef.current = incomingTicket;
      try { sessionStorage.setItem("jarvis_owner_pairing_ticket", incomingTicket); } catch { /* in-memory fallback */ }
      // Remove either transport from the visible URL before any subsequent
      // browser request can copy it into history or a referrer.
      history.replaceState(null, "", "/pair");
    }
    if (!ticketRef.current) {
      try { ticketRef.current = sessionStorage.getItem("jarvis_owner_pairing_ticket"); } catch { /* no storage */ }
    }
    const ticket = ticketRef.current;
    if (!ticket) {
      setStatus("invalid");
      return;
    }

    const retryLater = () => {
      if (!active) return;
      setStatus("unavailable");
      retryTimer = setTimeout(() => setAttempt((value) => value + 1), 2_000);
    };
    const clearTicket = () => {
      ticketRef.current = null;
      try { sessionStorage.removeItem("jarvis_owner_pairing_ticket"); } catch { /* already consumed */ }
    };
    const viewerStatus = () => fetch("/api/auth/viewer", {
      method: "POST",
      cache: "no-store",
      credentials: "include",
    });

    const enroll = async () => {
      setStatus("pairing");
      // This makes retries idempotent: if the pair response was lost after the
      // secure cookie was set, the already-enrolled browser simply continues.
      const existing = await viewerStatus();
      if (existing.ok) {
        clearTicket();
        window.location.replace("/");
        return;
      }
      if (existing.status >= 500) return retryLater();

      const response = await fetch("/api/auth/pair", {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (response.status >= 500) return retryLater();
      if (!response.ok) {
        clearTicket();
        if (active) setStatus("invalid");
        return;
      }

      const verified = await viewerStatus();
      if (verified.ok) {
        clearTicket();
        window.location.replace("/");
      } else if (verified.status >= 500) {
        retryLater();
      } else {
        clearTicket();
        if (active) setStatus("storage");
      }
    };

    void enroll().catch(retryLater);
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [attempt]);

  const failed = status === "invalid" || status === "storage";
  const title = status === "invalid"
    ? "This link is invalid or has expired."
    : status === "storage"
      ? "This browser blocked the secure owner session."
      : status === "unavailable"
        ? "Jarvis is reconnecting…"
        : "Connecting Jarvis to this browser…";

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#050506] px-6 text-[#f4f2ed]">
      <section className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#0e0e10] p-8 shadow-2xl">
        <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.22em] text-amber">
          {failed ? "Owner connection unavailable" : "Pairing private workspace"}
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/55">
          {status === "invalid"
            ? "Request a fresh one-time owner link."
            : status === "storage"
              ? "Allow cookies for Jarvis in this browser, then open a fresh owner link."
              : status === "unavailable"
                ? "Your link is safe. Jarvis will retry automatically."
                : "The pairing code is single-use and is removed from the address immediately."}
        </p>
        {status === "unavailable" && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="mt-5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/45 transition hover:text-white/80"
          >
            Retry now
          </button>
        )}
      </section>
    </main>
  );
}
