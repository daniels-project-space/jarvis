"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CODEX_AUTH_ENROLLMENT_CONFIRMATION } from "@/lib/codex-auth-control";
import { viewerFetch } from "@/lib/viewer-request";

type AuthState =
  | "idle"
  | "queued"
  | "starting"
  | "waiting"
  | "connected"
  | "attention"
  | "unavailable";
type AuthStatus = Readonly<{
  ok: boolean;
  state: AuthState;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: number;
}>;

function validStatus(value: unknown): value is AuthStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = (value as Record<string, unknown>).state;
  return (
    typeof (value as Record<string, unknown>).ok === "boolean" &&
    [
      "idle",
      "queued",
      "starting",
      "waiting",
      "connected",
      "attention",
      "unavailable",
    ].includes(String(state))
  );
}

export function CodexAuthControl({
  compact = false,
  onConnected,
}: {
  compact?: boolean;
  onConnected?: () => void;
}) {
  const [status, setStatus] = useState<AuthStatus>({ ok: true, state: "idle" });
  const [busy, setBusy] = useState(false);
  const loginWindow = useRef<Window | null>(null);
  const openedCode = useRef<string | null>(null);

  const readStatus = useCallback(async () => {
    const response = await viewerFetch("/api/codex-auth", {
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    const next: AuthStatus =
      response.ok && validStatus(body)
        ? body
        : { ok: false, state: "unavailable" };
    setStatus(next);
    if (
      next.state === "waiting" &&
      next.verificationUri &&
      next.userCode &&
      openedCode.current !== next.userCode
    ) {
      openedCode.current = next.userCode;
      if (loginWindow.current && !loginWindow.current.closed) {
        loginWindow.current.location.href = next.verificationUri;
      }
    }
    if (next.state === "connected") {
      setBusy(false);
      onConnected?.();
    }
    return next;
  }, [onConnected]);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  useEffect(() => {
    if (!["queued", "starting", "waiting"].includes(status.state)) return;
    const timer = window.setTimeout(
      () => void readStatus(),
      status.state === "waiting" ? 1_500 : 900,
    );
    return () => window.clearTimeout(timer);
  }, [readStatus, status.state]);

  const reconnect = async () => {
    setBusy(true);
    openedCode.current = null;
    loginWindow.current = window.open(
      "about:blank",
      "jarvis-chatgpt-auth",
      "popup,width=560,height=720",
    );
    if (loginWindow.current) loginWindow.current.opener = null;
    try {
      const response = await viewerFetch("/api/codex-auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: CODEX_AUTH_ENROLLMENT_CONFIRMATION }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !validStatus(body)) throw new Error("unavailable");
      setStatus(body);
    } catch {
      loginWindow.current?.close();
      loginWindow.current = null;
      setStatus({ ok: false, state: "unavailable" });
      setBusy(false);
    }
  };

  const active =
    busy || ["queued", "starting", "waiting"].includes(status.state);
  const label =
    status.state === "connected"
      ? "ChatGPT connected"
      : status.state === "waiting"
        ? "Finish sign-in"
        : active
          ? "Preparing sign-in…"
          : "Reconnect ChatGPT";

  return (
    <div
      className={compact ? "flex min-w-0 items-center gap-2" : "space-y-2"}
      data-testid="codex-auth-control"
    >
      <button
        type="button"
        onClick={() => void reconnect()}
        disabled={active}
        className={`${compact ? "rounded-full px-3 py-1.5 text-[11px]" : "rounded-xl px-3 py-2 text-xs"} border border-cyan/25 bg-cyan/10 text-cyan transition hover:border-cyan/50 hover:bg-cyan/15 disabled:cursor-wait disabled:opacity-70`}
      >
        {label}
      </button>
      {status.state === "waiting" &&
        status.verificationUri &&
        status.userCode && (
          <div
            className={
              compact
                ? "flex min-w-0 items-center gap-2"
                : "rounded-xl border border-white/10 bg-black/25 p-3"
            }
          >
            <code className="select-all whitespace-nowrap text-xs font-semibold tracking-[0.16em] text-white">
              {status.userCode}
            </code>
            <a
              href={status.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="whitespace-nowrap text-[11px] text-cyan underline decoration-cyan/40 underline-offset-2"
            >
              Open sign-in
            </a>
          </div>
        )}
      {!compact && status.state === "waiting" && (
        <p className="text-[11px] leading-relaxed text-slate">
          Enter the code on OpenAI’s sign-in page. Jarvis will reconnect
          automatically when it finishes.
        </p>
      )}
      {!compact && ["attention", "unavailable"].includes(status.state) && (
        <p className="text-[11px] leading-relaxed text-amber-100">
          Sign-in could not finish. Try again; your existing work stays safely
          queued.
        </p>
      )}
    </div>
  );
}
