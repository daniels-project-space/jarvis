export type FastAgentDispatch = {
  task: string;
  agentId?: "paul" | "atlas" | "iris" | "maya" | "chloe" | "sentry";
};

const namedAgents = new Set(["paul", "atlas", "iris", "maya", "chloe", "sentry"]);
const vagueTask = /^(?:it|that|this|the task|the issue|something|what we discussed)(?:\s+please)?[.!?]*$/i;
const projectFeatureTask = /(?:\b(?:add(?:ed)?|build|implement(?:ed)?|create(?:d)?|make|fix(?:ed)?|improve(?:d)?|redesign(?:ed)?|change(?:d)?|update(?:d)?)\b.*\b(?:feature|button|control|page|screen|view|workflow|flow|form|filter|search|setting|tab|dashboard|ui|ux|integration|functionality|bug)\b|\b(?:feature|button|control|page|screen|view|workflow|flow|form|filter|search|setting|tab|dashboard|ui|ux|integration|functionality|bug)\b.*\b(?:add(?:ed)?|build|implement(?:ed)?|create(?:d)?|make|fix(?:ed)?|improve(?:d)?|redesign(?:ed)?|change(?:d)?|update(?:d)?)\b)/i;
const exploratoryHostRequest = /^(?:what|which|why|how|when|where|should|can\s+we|could\s+we)\b/i;

/**
 * Only explicit, singular delegation commands belong on the deterministic
 * fast lane. Vague follow-ups and fleet missions need conversational context
 * and Mastra decomposition, so they deliberately return null.
 */
export function parseFastAgentDispatch(input: string): FastAgentDispatch | null {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text || /\b(?:agents|team|fleet|mission|multiple|several)\b/i.test(text)) return null;

  const patterns = [
    /\b(?:launch|start|send|assign|spin\s+up|put)\s+(?:(?:an?|the)\s+)?(agent|paul|atlas|iris|maya|chloe|sentry)(?:\s+agent)?\s+(?:to|on|for)\s+(.+)$/i,
    /\b(?:have|get|ask)\s+(?:(?:an?|the)\s+)?(agent|paul|atlas|iris|maya|chloe|sentry)(?:\s+agent)?\s+(?:to|working\s+on)\s+(.+)$/i,
  ];
  const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
  if (!match) return null;
  const actor = String(match[1]).toLowerCase();
  const task = String(match[2]).trim().replace(/\s+(?:please|thanks?)\s*[.!?]*$/i, "").trim();
  if (task.length < 10 || vagueTask.test(task)) return null;
  return {
    task,
    agentId: namedAgents.has(actor) ? actor as FastAgentDispatch["agentId"] : undefined,
  };
}

/**
 * A host-scoped feature request is concrete enough to begin Paul’s durable
 * engineering workflow immediately. It is intentionally narrower than normal
 * conversation so exploratory or ambiguous requests still reach Jarvis first.
 */
export function parseProjectFeatureDispatch(input: string): FastAgentDispatch | null {
  const task = input.trim().replace(/\s+/g, " ");
  if (task.length < 14 || task.length > 1_400 || vagueTask.test(task) || exploratoryHostRequest.test(task) || !projectFeatureTask.test(task)) {
    return null;
  }
  return { task, agentId: "paul" };
}
