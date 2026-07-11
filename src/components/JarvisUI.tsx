"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import Orb from "./Orb";

const THREAD = "main";
type Msg = { _id: string; role: string; text: string; status: string };

export default function JarvisUI() {
  const messages = (useQuery(api.chatQueue.listMessages, { threadId: THREAD }) ?? []) as Msg[];
  const send = useMutation(api.chatQueue.sendMessage);
  const panel = useQuery(api.ui.getPanel, {}) as
    | { type: string; value: string; title?: string }
    | null
    | undefined;
  const clearPanel = useMutation(api.ui.clearPanel);
  const saveSub = useMutation(api.push.saveSub);
  const [input, setInput] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastSpokenId = useRef<string | null>(null);
  const recRef = useRef<any>(null);
  const energyRef = useRef(0);

  const busy = messages.some((m) => m.role === "assistant" && m.status === "streaming");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.text]);

  useEffect(() => {
    import("../lib/push").then((m) => m.registerSW());
  }, []);

  // Speak the newest finalized assistant message via open-source Kokoro TTS
  // (in-browser, en-GB butler voice), driving the orb from live audio amplitude.
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "done" && m.text);
    if (!last || last._id === lastSpokenId.current) return;
    lastSpokenId.current = last._id;
    (async () => {
      const { speak } = await import("../lib/kokoro");
      await speak(
        last.text,
        (e) => (energyRef.current = e),
        () => setSpeaking(true),
        () => setSpeaking(false),
      );
    })();
  }, [messages]);

  async function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    import("../lib/kokoro").then((m) => m.warm()); // gesture-warm audio + model
    setInput("");
    await send({ threadId: THREAD, text: t });
  }

  function toggleMic() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition needs Chrome/Edge.");
      return;
    }
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "en-GB";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => submit(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  const status = speaking ? "speaking…" : busy ? "thinking…" : listening ? "listening…" : "online";

  return (
    <div className="mx-auto grid w-full max-w-6xl flex-1 gap-4 p-4 md:grid-cols-2">
      <div className="relative min-h-[45vh] overflow-hidden rounded-2xl border border-neutral-800 bg-gradient-to-b from-neutral-950 to-black">
        {panel ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
              <span className="truncate text-xs text-neutral-400">{panel.title ?? panel.type}</span>
              <button
                onClick={() => clearPanel({})}
                className="rounded bg-neutral-800/80 px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700"
              >
                ✕ orb
              </button>
            </div>
            {panel.type === "url" ? (
              <div className="flex flex-1 flex-col">
                <iframe
                  src={panel.value}
                  className="w-full flex-1 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
                <a
                  href={panel.value}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2 text-center text-xs text-emerald-400"
                >
                  open ↗ (blank = the site blocks embedding)
                </a>
              </div>
            ) : panel.type === "image" ? (
              <img src={panel.value} alt={panel.title ?? ""} className="min-h-0 flex-1 object-contain" />
            ) : (
              <pre className="flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm text-neutral-200">
                {panel.value}
              </pre>
            )}
          </div>
        ) : (
          <>
            <Orb speaking={speaking} energyRef={energyRef} />
            <div className="pointer-events-none absolute bottom-3 left-0 right-0 text-center text-xs tracking-widest text-neutral-500">
              {status}
            </div>
          </>
        )}
      </div>
      <div className="flex h-[70vh] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/50">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 && (
            <p className="mt-8 text-center text-sm text-neutral-600">Speak or type, sir.</p>
          )}
          {messages.map((m) => (
            <div key={m._id} className={m.role === "user" ? "text-right" : "text-left"}>
              <span
                className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                  m.role === "user" ? "bg-emerald-500/15 text-emerald-100" : "bg-neutral-800/80 text-neutral-200"
                }`}
              >
                {m.text || (m.status === "streaming" ? "…" : "")}
              </span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2 border-t border-neutral-800 p-3">
          <button
            onClick={async () => {
              const r = await (await import("../lib/push")).subscribePush(saveSub);
              alert(
                r === "subscribed"
                  ? "Notifications on — JARVIS will ping this device."
                  : r === "unsupported"
                    ? "On iPhone: Share → Add to Home Screen, then open JARVIS from that icon to enable push."
                    : r === "denied"
                      ? "Notifications are blocked in your browser settings."
                      : "Push isn't available here.",
              );
            }}
            title="enable phone notifications"
            className="rounded-xl bg-neutral-800 px-3 text-sm text-neutral-300 hover:bg-neutral-700"
          >
            🔔
          </button>
          <button
            onClick={toggleMic}
            title="voice input"
            className={`rounded-xl px-3 text-sm ${listening ? "bg-red-600 text-white" : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"}`}
          >
            {listening ? "◉" : "🎙"}
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit(input)}
            placeholder={busy ? "JARVIS is thinking…" : "Ask JARVIS…"}
            className="flex-1 rounded-xl bg-neutral-950 px-4 py-2 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-emerald-600"
          />
          <button
            onClick={() => submit(input)}
            disabled={busy}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
