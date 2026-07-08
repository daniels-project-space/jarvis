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
  const [input, setInput] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastSpokenId = useRef<string | null>(null);
  const recRef = useRef<any>(null);

  const busy = messages.some((m) => m.role === "assistant" && m.status === "streaming");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.text]);

  // Speak the newest finalized assistant message once (browser TTS, British voice).
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.status === "done" && m.text);
    if (!last || last._id === lastSpokenId.current) return;
    lastSpokenId.current = last._id;
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(last.text);
    const voices = window.speechSynthesis.getVoices();
    const gb =
      voices.find((v) => /en-GB/.test(v.lang) && /male|daniel|arthur|george|uk/i.test(v.name)) ||
      voices.find((v) => /en-GB/.test(v.lang));
    if (gb) u.voice = gb;
    u.rate = 1.02;
    u.pitch = 0.9;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [messages]);

  async function submit(text: string) {
    const t = text.trim();
    if (!t) return;
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
        <Orb speaking={speaking} />
        <div className="pointer-events-none absolute bottom-3 left-0 right-0 text-center text-xs tracking-widest text-neutral-500">
          {status}
        </div>
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
