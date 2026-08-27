"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTO_MOOD_HOLD_MS,
  freshAutomaticOrbMood,
  inferConversationMood,
  isOrbMood,
  type OrbMood,
  type OrbMoodRow,
} from "./conversation-mood";

export type ConversationMoodMessage = {
  _id: string;
  delivery?: string;
  role: string;
  status?: string;
  text: string;
};

type MoodSource = "automatic" | "conversation" | "manual";

type ConversationMoodOptions = {
  messages: readonly ConversationMoodMessage[];
  messagesHydrated: boolean;
  moodRow: OrbMoodRow | null | undefined;
  thread: string;
};

/**
 * Keeps JARVIS's visual register in step with the real, already-rendered
 * conversation. No transcript-derived signal leaves this browser: a recent
 * explicit orb_mood nudge can briefly lead, a manual choice remains sovereign,
 * and every other turn is understood locally.
 */
export function useConversationMood({
  messages,
  messagesHydrated,
  moodRow,
  thread,
}: ConversationMoodOptions) {
  const [contextMood, setContextMood] = useState<OrbMood>("calm");
  const [automaticMood, setAutomaticMood] = useState<{ mood: OrbMood; thread: string; updatedAt: number } | null>(null);
  const manualMood: OrbMood | null = moodRow?.title === "manual" && isOrbMood(moodRow.value) ? moodRow.value : null;
  const freshAutoMood = freshAutomaticOrbMood(moodRow, thread);
  const automaticRowRef = useRef<{ thread: string; updatedAt: number | null } | null>(null);
  // State changes run after paint. Gate the previous thread synchronously too,
  // so a tab switch cannot flash an automatic mood from its former context.
  const automaticMoodForThread = automaticMood?.thread === thread ? automaticMood.mood : null;
  const automaticMoodStateForThread = automaticMood?.thread === thread ? automaticMood : null;

  // ui.getMood is intentionally a small, global presentation record. A model
  // write carries its originating thread and is only accepted after this
  // thread has become active; a clear/manual row is never mistaken for a
  // model nudge. A reload simply falls back to local history.
  useEffect(() => {
    if (moodRow === undefined) return;
    const updatedAt = typeof moodRow?.updatedAt === "number" ? moodRow.updatedAt : null;
    const observed = automaticRowRef.current;
    const foreignModelMood = moodRow?.title === "auto" && moodRow.source === "model" && moodRow.threadId !== thread;
    const scheduleExpiry = (candidate: NonNullable<typeof automaticMoodStateForThread>) => {
      const remainingMs = Math.max(0, AUTO_MOOD_HOLD_MS - (Date.now() - candidate.updatedAt));
      const expiry = window.setTimeout(() => setAutomaticMood(null), remainingMs);
      return () => window.clearTimeout(expiry);
    };
    // A singleton row can be overwritten by a late result for another chat.
    // It must neither leak into this thread nor cancel this thread's already
    // admitted brief hold; its own timer remains the authority.
    if (!manualMood && foreignModelMood && automaticMoodStateForThread) {
      return scheduleExpiry(automaticMoodStateForThread);
    }
    if (!observed || observed.thread !== thread) {
      automaticRowRef.current = { thread, updatedAt };
      setAutomaticMood(null);
      return;
    }

    if (manualMood || !freshAutoMood || updatedAt === observed.updatedAt) {
      if (updatedAt !== observed.updatedAt) observed.updatedAt = updatedAt;
      if (manualMood || !freshAutoMood) setAutomaticMood(null);
      return automaticMoodStateForThread && freshAutoMood && !manualMood
        ? scheduleExpiry(automaticMoodStateForThread)
        : undefined;
    }

    automaticRowRef.current = { thread, updatedAt };
    const nextAutomaticMood = { mood: freshAutoMood, thread, updatedAt: updatedAt ?? Date.now() };
    setAutomaticMood(nextAutomaticMood);
    return scheduleExpiry(nextAutomaticMood);
  }, [automaticMood, freshAutoMood, manualMood, moodRow?.updatedAt, thread]);

  const rememberConversationMood = useCallback((text: string) => {
    setContextMood((previous) => inferConversationMood(text, previous));
  }, []);

  const updateConversationMood = useCallback((text: string) => {
    // A fresh local utterance should respond immediately, rather than waiting
    // for a previous model nudge to time out.
    setAutomaticMood(null);
    rememberConversationMood(text);
  }, [rememberConversationMood]);

  const moodThreadRef = useRef<string | null>(null);
  const moodAssistantMessageRef = useRef<string | null>(null);
  useEffect(() => {
    if (!messagesHydrated) return;
    const conversational = messages.filter((message) => message.delivery !== "notification" && message.text && (
      message.role === "user" || (message.role === "assistant" && message.status === "done")
    ));
    const latestAssistant = [...conversational].reverse().find((message) => message.role === "assistant");

    // A thread restore starts from the recent conversation rather than a
    // sterile green reset. It reads only text already present in the view.
    if (moodThreadRef.current !== thread) {
      moodThreadRef.current = thread;
      moodAssistantMessageRef.current = latestAssistant?._id ?? null;
      setAutomaticMood(null);
      setContextMood(conversational.slice(-8).reduce<OrbMood>(
        (mood, message) => inferConversationMood(message.text, mood),
        "calm",
      ));
      return;
    }

    if (!latestAssistant || latestAssistant._id === moodAssistantMessageRef.current) return;
    moodAssistantMessageRef.current = latestAssistant._id;
    // The model-selected register remains visible for its brief hold, but the
    // new reply is retained underneath it so expiry reveals its actual tone.
    // Convex can publish orb_mood and the completed reply in the same React
    // commit. `freshAutoMood` catches that pre-effect window, so this reply
    // cannot clear the just-arrived model choice before its state setter lands.
    if (automaticMoodForThread || freshAutoMood) {
      rememberConversationMood(latestAssistant.text);
      return;
    }
    updateConversationMood(latestAssistant.text);
  }, [automaticMoodForThread, freshAutoMood, messages, messagesHydrated, rememberConversationMood, thread, updateConversationMood]);

  const activeMood = manualMood ?? automaticMoodForThread ?? contextMood;
  const moodSource: MoodSource = manualMood ? "manual" : automaticMoodForThread ? "automatic" : "conversation";

  return { activeMood, moodSource, updateConversationMood };
}
