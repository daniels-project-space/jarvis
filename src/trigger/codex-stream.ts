export type AgentStreamState = {
  text: string;
  itemId?: string;
};

// Codex may emit several agentMessage items around tool calls. Deltas inside an
// item already contain their own spacing, but the app-server protocol does not
// insert anything between two completed message items. Preserve that boundary
// so captions and speech do not become "finished.Next".
export function appendAgentMessageDelta(
  state: AgentStreamState,
  delta: string,
  itemId?: string,
): { state: AgentStreamState; emitted: string } {
  const changedItem = Boolean(state.text && state.itemId && itemId && state.itemId !== itemId);
  const separator = changedItem && !/\s$/.test(state.text) && !/^\s/.test(delta) ? "\n\n" : "";
  const emitted = separator + delta;
  return {
    state: { text: state.text + emitted, itemId: itemId ?? state.itemId },
    emitted,
  };
}
