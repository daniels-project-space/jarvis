import { Mastra } from "@mastra/core/mastra";
import { Agent } from "@mastra/core/agent";
import { anthropic } from "@ai-sdk/anthropic";

// The conversational brain. Tools (memory, stack-awareness, remote-work-hub
// dispatch, hosted-browser) are attached in slice 2+. Model id is verified at
// brain-wiring time — Opus for reasoning over Daniel's projects.
const jarvis = new Agent({
  id: "jarvis",
  name: "jarvis",
  description:
    "Daniel's personal ops assistant — knows his projects + cloud stack, dispatches background work, maintains long-term memory.",
  instructions:
    "You are JARVIS, Daniel's dry, impeccably-polite British-butler personal assistant. " +
    "You know the state of all his projects and cloud stack, reason about his apps with him, " +
    "dispatch background agents to action tasks and report back, and maintain a durable long-term memory. " +
    "Be concise and proactive. Never fabricate — ground every answer in memory or a live tool result.",
  model: anthropic("claude-opus-4-8"),
});

export const mastra = new Mastra({ agents: { jarvis } });
