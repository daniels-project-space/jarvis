import "server-only";

// This is intentionally separate from the broader Jarvis context snapshot.
// The Hub façade accepts only this dedicated capability and only the four
// explicitly named operations below.
export const HUB_ACTIONS_URL = "https://fantastic-roadrunner-485.convex.cloud";

export type HubActionsEnvironment = Readonly<Record<string, string | undefined>>;

export type HubTodo = Readonly<{
  id: string;
  text: string;
  done: boolean;
  priority: number;
  dueDate?: number;
  tags?: string[];
  projectSlug?: string;
  position: number;
  createdAt: number;
}>;

export type HubWidget = Readonly<{
  id: string;
  type: string;
  position: number;
  enabled: boolean;
  w: number;
  h: number;
}>;

export type HubTodoCreateInput = Readonly<{
  text: string;
  priority?: number;
  dueDate?: number;
  tags?: string[];
}>;

export type HubTodoUpdateInput = Readonly<{
  id: string;
  text?: string;
  priority?: number;
  dueDate?: number;
  done?: boolean;
}>;

export type HubActionsRequestOptions = Readonly<{
  environment?: HubActionsEnvironment;
  fetchImpl?: typeof fetch;
  hubUrl?: string;
}>;

export class HubActionsUnavailableError extends Error {
  constructor() {
    super("Project Hub actions are not configured");
    this.name = "HubActionsUnavailableError";
  }
}

export function hubActionsRequestArgs(
  environment: HubActionsEnvironment = process.env,
): { vaultToken: string } | null {
  // Never substitute VAULT_ACCESS_TOKEN here. The new Hub façade has its own
  // read/write capability and a broader vault token would defeat its boundary.
  const token = environment.JARVIS_HUB_ACTIONS_TOKEN?.trim();
  return token ? { vaultToken: token } : null;
}

export function hubActionsReadiness(
  environment: HubActionsEnvironment = process.env,
): { configured: boolean } {
  return { configured: hubActionsRequestArgs(environment) !== null };
}

type HubActionPath =
  | "jarvisActions:listTodos"
  | "jarvisActions:listWidgets"
  | "jarvisActions:createTodo"
  | "jarvisActions:updateTodo";

async function requestHubAction<T>(
  kind: "query" | "mutation",
  path: HubActionPath,
  args: Record<string, unknown>,
  options: HubActionsRequestOptions = {},
): Promise<T> {
  const vaultArgs = hubActionsRequestArgs(options.environment);
  if (!vaultArgs) throw new HubActionsUnavailableError();

  const response = await (options.fetchImpl ?? fetch)(`${options.hubUrl ?? HUB_ACTIONS_URL}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The capability travels only in this server-to-server JSON body. It is
    // never put in a URL, browser payload, request header, or child process.
    body: JSON.stringify({ path, args: { ...args, ...vaultArgs }, format: "json" }),
  });
  const payload = await response.json().catch(() => null) as {
    value?: T;
    status?: string;
    errorMessage?: string;
  } | null;
  if (!response.ok || payload?.status === "error") {
    throw new Error(`Project Hub ${path} failed`);
  }
  return payload?.value as T;
}

export async function listHubTodos(options?: HubActionsRequestOptions): Promise<HubTodo[]> {
  return await requestHubAction<HubTodo[]>("query", "jarvisActions:listTodos", {}, options);
}

export async function listHubWidgets(options?: HubActionsRequestOptions): Promise<HubWidget[]> {
  return await requestHubAction<HubWidget[]>("query", "jarvisActions:listWidgets", {}, options);
}

export async function createHubTodo(
  input: HubTodoCreateInput,
  options?: HubActionsRequestOptions,
): Promise<{ id: string }> {
  const { text, priority, dueDate, tags } = input;
  return await requestHubAction<{ id: string }>("mutation", "jarvisActions:createTodo", {
    text,
    ...(priority === undefined ? {} : { priority }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(tags === undefined ? {} : { tags }),
  }, options);
}

export async function updateHubTodo(
  input: HubTodoUpdateInput,
  options?: HubActionsRequestOptions,
): Promise<{ id: string }> {
  const { id, text, priority, dueDate, done } = input;
  return await requestHubAction<{ id: string }>("mutation", "jarvisActions:updateTodo", {
    id,
    ...(text === undefined ? {} : { text }),
    ...(priority === undefined ? {} : { priority }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(done === undefined ? {} : { done }),
  }, options);
}

export function hubActionsFailureMessage(error: unknown): string {
  return error instanceof HubActionsUnavailableError
    ? "Project Hub to-do access is not configured. Nothing changed."
    : "Project Hub to-do access is temporarily unavailable. Nothing changed.";
}
