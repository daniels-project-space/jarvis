import { task } from "@trigger.dev/sdk/v3";

// Smoke task proving the jarvis-jobs Trigger.dev project is wired.
// Real tasks (memory consolidation, morning briefing, stack polling,
// remote-work-hub orchestration) land in slices 2-7.
export const hello = task({
  id: "hello",
  run: async (payload: { name?: string }) => {
    return { greeting: `JARVIS online, ${payload?.name ?? "sir"}.`, at: new Date().toISOString() };
  },
});
