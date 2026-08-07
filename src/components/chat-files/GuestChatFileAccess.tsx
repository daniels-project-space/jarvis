"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function GuestChatFileAccess({
  embedded,
  onRequestOwnerAccess,
}: {
  embedded: boolean;
  onRequestOwnerAccess: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  return (
    <div
      ref={rootRef}
      className="relative shrink-0 self-stretch"
      data-jarvis-attachment-access="guest-locked"
      data-jarvis-attachment-surface={embedded ? "embedded" : "standalone"}
    >
      <button
        id="jarvis-attachment-trigger"
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-controls="jarvis-attachment-owner-access"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Attach files — connect owner tools"
        aria-describedby="jarvis-attachment-owner-access-description"
        title="Attach files — connect owner tools"
        className="relative flex h-9 items-center justify-center gap-1.5 rounded-xl px-2 text-slate ring-1 ring-white/10 transition hover:bg-white/[0.06] hover:text-cyan sm:h-10 sm:px-2.5"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.7 9.7a2 2 0 0 1-2.8-2.8l9-9" />
        </svg>
        <span className="hidden text-[10px] font-medium sm:inline">attach</span>
        <span aria-hidden="true" className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-[#071017] text-amber ring-1 ring-amber/40">
          <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
          </svg>
        </span>
      </button>
      <span id="jarvis-attachment-owner-access-description" className="sr-only">
        {embedded
          ? "Connect the signed-in Jarvis session before uploading files in this app."
          : "Private uploads need an enrolled owner session in this browser."}
      </span>

      {open && (
        <section
          id="jarvis-attachment-owner-access"
          role="dialog"
          aria-modal="false"
          aria-labelledby="jarvis-attachment-owner-access-title"
          className="absolute bottom-full left-0 z-[70] mb-2 w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-white/12 bg-[#071017]/98 shadow-2xl shadow-black/60 backdrop-blur-xl"
        >
          <header className="flex items-start justify-between gap-3 border-b border-white/8 px-3 py-2.5">
            <div>
              <h3 id="jarvis-attachment-owner-access-title" className="text-xs font-medium text-white">Attach files privately</h3>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                {embedded
                  ? "Connect the signed-in Jarvis session to upload files here."
                  : "This browser is in public guest mode. Private uploads need an enrolled owner session."}
              </p>
            </div>
            <button type="button" onClick={close} aria-label="Close attachment access" className="grid size-9 shrink-0 place-items-center rounded-full text-lg text-slate-400 hover:bg-white/10 hover:text-white">×</button>
          </header>
          <div className="p-2.5">
            <button
              type="button"
              onClick={onRequestOwnerAccess}
              className="min-h-10 w-full rounded-xl bg-cyan/15 px-3 text-xs font-medium text-cyan ring-1 ring-cyan/35 transition hover:bg-cyan/25"
            >
              {embedded ? "connect owner tools" : "check owner access"}
            </button>
            <p className="mt-2 text-[9px] leading-relaxed text-slate-500">Guest sessions never receive file inputs or access to the private saved-file library.</p>
          </div>
        </section>
      )}
    </div>
  );
}
