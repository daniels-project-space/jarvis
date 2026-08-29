import "server-only";

// This is intentionally separate from the broader Jarvis context snapshot.
// The Hub façade accepts only this dedicated capability and only the four
// explicitly named operations below.
export const HUB_ACTIONS_URL = "https://fantastic-roadrunner-485.convex.cloud";
// Read-only Hub context/status calls must not consume a foreground turn or a
// durable refresh until their much larger outer worker deadlines. This is an
// overall deadline (including a stalled response body), not just a connection
// timeout. Mutations deliberately do not use it: once a write left Jarvis, a
// timeout cannot truthfully say whether Hub committed it.
export const HUB_ACTIONS_TIMEOUT_MS = 5_000;

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

export type HubWealth = Readonly<{
  totalGBP: number;
  asOf: number | null;
  oldestPricedAt: number | null;
  assetCount: number;
  usdPerGbp: number | null;
  categories: ReadonlyArray<Readonly<{ category: string; totalGBP: number }>>;
  cashflow: Readonly<{
    confirmedRentalGbp: number;
    expensesAccruedGbp: number;
    netCashflowGbp: number;
  }>;
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
  // Applies only to read-only query calls. Mutation calls intentionally retain
  // their existing transport semantics so a response loss cannot be mistaken
  // for a failed write.
  //
  // Internal callers and tests may request a shorter deadline, never a longer
  // one. The shared default remains the hard ceiling for query calls.
  timeoutMs?: number;
}>;

export class HubActionsUnavailableError extends Error {
  constructor() {
    super("Project Hub actions are not configured");
    this.name = "HubActionsUnavailableError";
  }
}

export class HubActionsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Project Hub action timed out after ${timeoutMs}ms`);
    this.name = "HubActionsTimeoutError";
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
  | "jarvisActions:getWealth"
  | "jarvisActions:createTodo"
  | "jarvisActions:updateTodo";

type HubActionKind = "query" | "mutation";

type HubActionPayload<T> = Readonly<{
  value?: T;
  status?: string;
  errorMessage?: string;
}>;

function isReadOnlyHubAction(kind: HubActionKind): kind is "query" {
  // The only read-only façade calls use Convex queries (`listTodos` and
  // `listWidgets`). Keeping this classification at the transport boundary
  // prevents a future caller from accidentally putting a write on a deadline.
  return kind === "query";
}

function isHubActionPayload(value: unknown): value is HubActionPayload<unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccessfulReadHubActionPayload(
  value: unknown,
): value is HubActionPayload<unknown> & Readonly<{ value: unknown }> {
  return isHubActionPayload(value) && Object.prototype.hasOwnProperty.call(value, "value");
}

function boundedHubActionsTimeout(value: unknown): number {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return HUB_ACTIONS_TIMEOUT_MS;
  // A tiny lower bound avoids a caller accidentally converting a safe fail
  // closed result into a synchronous failure, while still allowing focused
  // tests and intentionally fast callers to use a shorter budget.
  return Math.min(HUB_ACTIONS_TIMEOUT_MS, Math.max(25, Math.floor(requested)));
}

function requireHubActionList<T>(value: unknown, path: HubActionPath): T[] {
  if (!Array.isArray(value)) throw new Error(`Project Hub ${path} failed`);
  return value as T[];
}

async function requestHubAction<T>(
  kind: HubActionKind,
  path: HubActionPath,
  args: Record<string, unknown>,
  options: HubActionsRequestOptions = {},
): Promise<T> {
  const vaultArgs = hubActionsRequestArgs(options.environment);
  if (!vaultArgs) throw new HubActionsUnavailableError();

  const request = async (signal?: AbortSignal): Promise<T> => {
    const response = await (options.fetchImpl ?? fetch)(`${options.hubUrl ?? HUB_ACTIONS_URL}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(signal ? { signal } : {}),
      // The capability travels only in this server-to-server JSON body. It is
      // never put in a URL, browser payload, request header, or child process.
      body: JSON.stringify({ path, args: { ...args, ...vaultArgs }, format: "json" }),
    });
    const payload = await response.json().catch((error) => {
      // Do not turn an abort while reading the response body into a seemingly
      // successful `undefined` action result.
      if (signal?.aborted) throw error;
      // Read-only context/status calls can safely fail closed on a malformed
      // body without exposing a transport/parser detail to their callers.
      if (isReadOnlyHubAction(kind)) throw new Error(`Project Hub ${path} failed`);
      return null;
    }) as unknown;
    const isReadOnly = isReadOnlyHubAction(kind);
    if (
      !response.ok ||
      (isHubActionPayload(payload) && payload.status === "error") ||
      (isReadOnly && !isSuccessfulReadHubActionPayload(payload))
    ) {
      throw new Error(`Project Hub ${path} failed`);
    }
    return (payload as HubActionPayload<T> | null)?.value as T;
  };

  if (!isReadOnlyHubAction(kind)) {
    // Preserve the prior write transport exactly: no deadline, cancellation,
    // or replay. A late create/update result is more honest than falsely
    // claiming that nothing changed after Hub accepted the mutation.
    return await request();
  }

  const timeoutMs = boundedHubActionsTimeout(options.timeoutMs);
  const controller = new AbortController();
  const timeoutError = new HubActionsTimeoutError(timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Abort transports that honor a signal, and race the full request so a
      // test/custom transport that ignores it cannot strand the caller.
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), deadline]);
  } catch (error) {
    // Some fetch implementations reject from their abort listener before the
    // deadline promise is observed. Preserve one stable fail-closed error for
    // callers either way.
    if (controller.signal.aborted && controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function listHubTodos(options?: HubActionsRequestOptions): Promise<HubTodo[]> {
  return requireHubActionList<HubTodo>(
    await requestHubAction<unknown>("query", "jarvisActions:listTodos", {}, options),
    "jarvisActions:listTodos",
  );
}

export async function listHubWidgets(options?: HubActionsRequestOptions): Promise<HubWidget[]> {
  return requireHubActionList<HubWidget>(
    await requestHubAction<unknown>("query", "jarvisActions:listWidgets", {}, options),
    "jarvisActions:listWidgets",
  );
}

function requireFiniteNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Project Hub jarvisActions:getWealth returned invalid ${field}`);
  return number;
}

function requireNullableTimestamp(value: unknown, field: string): number | null {
  if (value === null) return null;
  const timestamp = requireFiniteNumber(value, field);
  if (timestamp < 0 || timestamp > 4_102_444_800_000) {
    throw new Error(`Project Hub jarvisActions:getWealth returned invalid ${field}`);
  }
  return timestamp;
}

function requireHubWealth(value: unknown): HubWealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project Hub jarvisActions:getWealth failed");
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.categories) || row.categories.length > 24) {
    throw new Error("Project Hub jarvisActions:getWealth failed");
  }
  const cashflow = row.cashflow;
  if (typeof cashflow !== "object" || cashflow === null || Array.isArray(cashflow)) {
    throw new Error("Project Hub jarvisActions:getWealth failed");
  }
  const categories = row.categories.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Project Hub jarvisActions:getWealth failed");
    }
    const category = entry as Record<string, unknown>;
    if (typeof category.category !== "string" || !category.category.trim() || category.category.length > 40) {
      throw new Error("Project Hub jarvisActions:getWealth failed");
    }
    return {
      category: category.category,
      totalGBP: requireFiniteNumber(category.totalGBP, "category total"),
    };
  });
  const cashflowRow = cashflow as Record<string, unknown>;
  return {
    totalGBP: requireFiniteNumber(row.totalGBP, "total"),
    asOf: requireNullableTimestamp(row.asOf, "as-of time"),
    oldestPricedAt: requireNullableTimestamp(row.oldestPricedAt, "oldest price time"),
    assetCount: Math.max(0, Math.floor(requireFiniteNumber(row.assetCount, "asset count"))),
    usdPerGbp: row.usdPerGbp === null ? null : requireFiniteNumber(row.usdPerGbp, "exchange rate"),
    categories,
    cashflow: {
      confirmedRentalGbp: requireFiniteNumber(cashflowRow.confirmedRentalGbp, "rental cashflow"),
      expensesAccruedGbp: requireFiniteNumber(cashflowRow.expensesAccruedGbp, "accrued expenses"),
      netCashflowGbp: requireFiniteNumber(cashflowRow.netCashflowGbp, "net cashflow"),
    },
  };
}

export async function getHubWealth(options?: HubActionsRequestOptions): Promise<HubWealth> {
  return requireHubWealth(
    await requestHubAction<unknown>("query", "jarvisActions:getWealth", {}, options),
  );
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

export function hubWealthFailureMessage(error: unknown): string {
  return error instanceof HubActionsUnavailableError
    ? "Project Hub wealth access is not configured yet."
    : "Project Hub wealth data is temporarily unavailable.";
}
