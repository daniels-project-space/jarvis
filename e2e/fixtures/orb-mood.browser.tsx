import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import ThreeOrb from "../../src/components/ThreeOrb";
import { AUTO_MOOD_HOLD_MS, MOOD_COLORS, type OrbMoodRow } from "../../src/lib/conversation-mood";
import { useConversationMood, type ConversationMoodMessage } from "../../src/lib/use-conversation-mood";

const params = new URLSearchParams(window.location.search);
const reduceMotion = params.get("reduced") === "1";
const forceFallback = params.get("fallback") === "1";

function MoodOrbFixture() {
  const [thread, setThread] = useState("thread-a");
  const [messages, setMessages] = useState<ConversationMoodMessage[]>([]);
  const [moodRow, setMoodRow] = useState<OrbMoodRow | null | undefined>(null);
  const energyRef = useRef(0);
  const automaticTurnRef = useRef(0);
  const { activeMood, moodSource } = useConversationMood({
    messages,
    messagesHydrated: true,
    moodRow,
    thread,
  });

  const complete = (id: string, text: string) => {
    setMessages((current) => [...current, { _id: id, role: "assistant", status: "done", text }]);
  };

  const completeWithAutomaticMood = () => {
    const updatedAt = Date.now();
    // This mirrors a tool call plus final reply arriving in the same render.
    setMoodRow({ title: "auto", source: "model", threadId: thread, value: "tender", updatedAt });
    automaticTurnRef.current += 1;
    complete(`assistant-focused-${automaticTurnRef.current}`, "I have the focused implementation plan ready.");
  };

  const completeWithNearExpiryAutomaticMood = () => {
    automaticTurnRef.current += 1;
    setMoodRow({
      title: "auto",
      source: "model",
      threadId: thread,
      value: "tender",
      updatedAt: Date.now() - AUTO_MOOD_HOLD_MS + 900,
    });
    complete(`assistant-near-expiry-${automaticTurnRef.current}`, "I have the focused implementation plan ready.");
  };

  return (
    <main
      aria-label="Jarvis orb mood fixture"
      data-jarvis-mood={activeMood}
      data-jarvis-mood-source={moodSource}
      data-reduced-motion={reduceMotion ? "true" : "false"}
      data-thread={thread}
      style={{
        alignItems: "center",
        background: "#05070d",
        color: "#d8f5ff",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        gap: 18,
        height: "100dvh",
        justifyContent: "center",
        overflow: "hidden",
        width: "100vw",
      }}
    >
      <div style={{ height: "min(68vw, 420px)", maxHeight: "58dvh", maxWidth: "min(68vw, 420px)", position: "relative", width: "min(68vw, 420px)" }}>
        <ThreeOrb
          energyRef={energyRef}
          forceFallback={forceFallback}
          mood={activeMood}
          moodColor={MOOD_COLORS[activeMood]}
          reduceMotion={reduceMotion}
          state="idle"
        />
      </div>
      <p aria-live="polite" data-orb-mood-label style={{ color: MOOD_COLORS[activeMood], fontSize: 13, letterSpacing: "0.14em", margin: 0, textTransform: "uppercase" }}>
        {activeMood} register — {moodSource}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 560 }}>
        <button type="button" onClick={() => complete("assistant-alert", "This is urgent: the deploy is failing.")}>Complete urgent reply</button>
        <button type="button" onClick={completeWithAutomaticMood}>Complete reply with automatic tender mood</button>
        <button type="button" onClick={completeWithNearExpiryAutomaticMood}>Complete reply with near-expiry tender mood</button>
        <button type="button" onClick={() => setMoodRow({ title: "auto", source: "model", threadId: thread, value: "tender", updatedAt: Date.now() - AUTO_MOOD_HOLD_MS - 1 })}>Expire automatic mood</button>
        <button type="button" onClick={() => setMoodRow({ title: "manual", value: "serious", updatedAt: Date.now() })}>Choose manual serious mood</button>
        <button type="button" onClick={() => setMoodRow({ title: "auto", source: "cleared", value: "calm", updatedAt: Date.now() })}>Return to automatic</button>
        <button type="button" onClick={() => {
          setThread("thread-b");
          setMessages([{ _id: "thread-b-alert", role: "assistant", status: "done", text: "This is urgent: thread B needs attention." }]);
        }}>Switch to another thread</button>
        <button type="button" onClick={() => setMoodRow({ title: "auto", source: "model", threadId: "thread-a", value: "tender", updatedAt: Date.now() })}>Deliver delayed thread A mood</button>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Orb mood fixture root is missing.");

createRoot(root).render(<MoodOrbFixture />);
