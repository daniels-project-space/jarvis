"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../convex/_generated/api";
import { useJarvisQuery } from "@/lib/secure-convex";
import { isGuestViewerSession, useViewerSession } from "@/lib/viewer-session";
import { clientMutation } from "@/lib/client-mutation";
import { registerSW, subscribePush } from "@/lib/push";

// Notification bell for the JARVIS cockpit.
//
// Kept in its own file rather than added to JarvisUI.tsx, which is already
// ~278KB — this needs to stay readable.
//
// The bell is the durable surface and push is the optional interrupt on top:
// a muted category still lands here, so turning off notifications loses the
// buzz, never the signal.

const CATEGORIES = [
  { key: "price_hunt", label: "Price hunts", hint: "A hunt found your price" },
  { key: "errand", label: "Errands", hint: "Emails and browser jobs finishing" },
  { key: "work", label: "Work", hint: "Background agents needing you" },
  { key: "reminder", label: "Reminders", hint: "Briefings and scheduled nudges" },
  { key: "incident", label: "Incidents", hint: "Something broke" },
] as const;

type PushState = "idle" | "working" | "subscribed" | "denied" | "unsupported" | "no-key";

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [pushState, setPushState] = useState<PushState>("idle");

  // Guests share the chat surface but never Daniel's signals, so the bell is
  // absent rather than merely empty for them — a visible count of things they
  // cannot open is both a leak and a confusing affordance.
  const viewerToken = useViewerSession();
  const isGuest = isGuestViewerSession(viewerToken);

  // Optional chaining guards test/partial-mock environments where only part of
  // the generated api surface is present.
  const events = useJarvisQuery(api.watchRules?.openEvents, isGuest ? "skip" : { limit: 20 });
  const prefs = useJarvisQuery(api.notificationPrefs?.get, isGuest ? "skip" : {});

  useEffect(() => {
    void registerSW();
  }, []);

  const unread = events?.length ?? 0;
  // A signal is "glowing" while its glowUntil window is live — the same field
  // the watch runtime already sets, so the bell and the workspace agree.
  const glowing = useMemo(
    () => (events ?? []).some((event: any) => Number(event.glowUntil ?? 0) > Date.now()),
    [events],
  );

  const enablePush = useCallback(async () => {
    setPushState("working");
    const result = await subscribePush((sub) => clientMutation("push:saveSub", sub));
    setPushState(result === "subscribed" ? "subscribed" : (result as PushState));
    if (result === "subscribed") {
      await clientMutation("notificationPrefs:update", { pushEnabled: true }).catch(() => {});
    }
  }, []);

  const toggleCategory = useCallback(async (key: string, next: boolean) => {
    await clientMutation("notificationPrefs:update", { categories: { [key]: next } }).catch(() => {});
  }, []);

  const openPanel = useCallback(async () => {
    setOpen((wasOpen) => !wasOpen);
    // Opening the panel is the read receipt; the events stay in history as
    // "seen" so nothing is lost, only un-counted.
    if (!open && unread > 0) {
      await clientMutation("watchRules:markEventsSeen", {}).catch(() => {});
    }
  }, [open, unread]);

  const dismiss = useCallback(async (id: string) => {
    await clientMutation("watchRules:dismissEvent", { id }).catch(() => {});
  }, []);

  const categories = (prefs?.categories ?? {}) as Record<string, boolean>;
  const pushEnabled = prefs?.pushEnabled !== false;

  if (isGuest) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={openPanel}
        aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
        className={`relative grid h-9 w-9 place-items-center rounded-full border transition
          ${glowing
            ? "border-amber-300/70 bg-amber-400/10 text-amber-200 shadow-[0_0_18px_rgba(251,191,36,0.55)] animate-pulse"
            : "border-cyan-300/30 bg-cyan-400/5 text-cyan-200/80 hover:border-cyan-300/60"}`}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" strokeLinejoin="round" />
          <path d="M10 18.5a2 2 0 0 0 4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-[1.15rem] rounded-full bg-amber-400 px-1 text-[0.65rem] font-semibold leading-[1.15rem] text-black">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[22rem] rounded-xl border border-cyan-300/25 bg-[#06121b]/95 p-3 shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-widest text-cyan-200/70">Signals</span>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-cyan-200/50 hover:text-cyan-200">
              close
            </button>
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto">
            {unread === 0 && <p className="py-4 text-center text-xs text-cyan-100/40">Nothing waiting.</p>}
            {(events ?? []).map((event: any) => (
              <div
                key={String(event._id)}
                className={`rounded-lg border p-2 ${Number(event.glowUntil ?? 0) > Date.now()
                  ? "border-amber-300/50 bg-amber-400/10 shadow-[0_0_12px_rgba(251,191,36,0.3)]"
                  : "border-cyan-300/15 bg-cyan-400/5"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm text-cyan-50">{event.title}</p>
                  <button
                    type="button"
                    onClick={() => dismiss(String(event._id))}
                    aria-label="Dismiss"
                    className="text-xs text-cyan-200/40 hover:text-cyan-200"
                  >
                    ×
                  </button>
                </div>
                {event.detail && <p className="mt-0.5 text-xs text-cyan-100/60">{event.detail}</p>}
              </div>
            ))}
          </div>

          <div className="mt-3 border-t border-cyan-300/15 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-cyan-200/70">Notify me about</span>
              {pushState !== "subscribed" && pushEnabled && (
                <button
                  type="button"
                  onClick={enablePush}
                  className="rounded border border-cyan-300/40 px-2 py-0.5 text-[0.7rem] text-cyan-200 hover:bg-cyan-400/10"
                >
                  {pushState === "working" ? "…" : "Enable push"}
                </button>
              )}
            </div>

            {pushState === "denied" && (
              <p className="mb-2 text-[0.7rem] text-amber-200/80">
                Blocked in browser settings — re-allow notifications for this site, then try again.
              </p>
            )}
            {pushState === "unsupported" && (
              <p className="mb-2 text-[0.7rem] text-amber-200/80">
                This browser needs the app added to your Home Screen before it can push.
              </p>
            )}
            {pushState === "no-key" && (
              <p className="mb-2 text-[0.7rem] text-amber-200/80">Push isn&apos;t configured on this deployment.</p>
            )}

            {CATEGORIES.map((category) => {
              const on = categories[category.key] !== false;
              return (
                <label key={category.key} className="flex cursor-pointer items-center justify-between py-1">
                  <span className="text-xs text-cyan-50/85" title={category.hint}>{category.label}</span>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggleCategory(category.key, e.target.checked)}
                    className="h-3.5 w-3.5 accent-cyan-400"
                  />
                </label>
              );
            })}

            <label className="mt-2 flex cursor-pointer items-center justify-between border-t border-cyan-300/10 pt-2">
              <span className="text-xs text-cyan-100/60">Push notifications</span>
              <input
                type="checkbox"
                checked={pushEnabled}
                onChange={(e) => clientMutation("notificationPrefs:update", { pushEnabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-cyan-400"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
