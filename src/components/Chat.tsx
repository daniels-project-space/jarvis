"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

const THREAD = "main";

type Msg = { _id: string; role: string; text: string; status: string };

export default function Chat() {
  const messages = (useQuery(api.chatQueue.listMessages, { threadId: THREAD }) ?? []) as Msg[];
  const send = useMutation(api.chatQueue.sendMessage);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.text]);

  const busy = messages.some((m) => m.role === "assistant" && m.status === "streaming");

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    await send({ threadId: THREAD, text });
  }

  return (
    <div className="flex h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900/50">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mt-8 text-center text-sm text-neutral-600">
            Speak, sir. Running on your subscription — I remember what you tell me.
          </p>
        )}
        {messages.map((m) => (
          <div key={m._id} className={m.role === "user" ? "text-right" : "text-left"}>
            <span
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${
                m.role === "user"
                  ? "bg-emerald-500/15 text-emerald-100"
                  : "bg-neutral-800/80 text-neutral-200"
              }`}
            >
              {m.text || (m.status === "streaming" ? "…" : "")}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-neutral-800 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={busy ? "JARVIS is thinking…" : "Ask JARVIS…"}
          className="flex-1 rounded-xl bg-neutral-950 px-4 py-2 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-emerald-600"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
