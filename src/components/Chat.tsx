"use client";
import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const line of parts) {
          const d = line.replace(/^data: /, "").trim();
          if (!d || d === "[DONE]") continue;
          try {
            const j = JSON.parse(d);
            if (j.text)
              setMessages((m) => {
                const c = [...m];
                c[c.length - 1] = { role: "assistant", content: c[c.length - 1].content + j.text };
                return c;
              });
            if (j.error)
              setMessages((m) => {
                const c = [...m];
                c[c.length - 1] = { role: "assistant", content: `⚠️ ${j.error}` };
                return c;
              });
          } catch {
            /* ignore partial */
          }
        }
      }
    } catch {
      setMessages((m) => {
        const c = [...m];
        c[c.length - 1] = { role: "assistant", content: "⚠️ connection error" };
        return c;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/50">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-neutral-600">
            Speak, sir. I remember what you tell me.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <span
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-emerald-500/15 text-emerald-100"
                  : "bg-neutral-800/80 text-neutral-200"
              }`}
            >
              {m.content || (busy ? "…" : "")}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask JARVIS…"
          className="flex-1 rounded-xl bg-neutral-950 px-4 py-2 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-emerald-600"
        />
        <button
          onClick={send}
          disabled={busy}
          className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
