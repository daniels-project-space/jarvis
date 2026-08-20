import {
  APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS,
  APPLE_MAPS_OFFLINE_RETRY_INTERVAL_MS,
  buildAppleMapsOfflinePreflight,
  isAppleMapsOfflinePreflightRefreshWindowOpen,
  nextAppleMapsOfflinePreflightRefreshAt,
} from "../lib/apple-maps-offline";
import {
  appleMapsOfflineGmailIdentity,
  appleMapsOfflineHubTodoTag,
  currentAppleMapsOfflineCityProof,
  matchesAppleMapsOfflineHubTodoTag,
  matchesAppleMapsOfflineCityProof,
  type AppleMapsOfflineCityProof,
  type AppleMapsOfflineGmailIdentity,
} from "../lib/apple-maps-offline-refresh";
import { lookupGmailBookingForAppleMapsPreflight, type ConfirmedBooking } from "../lib/booking-email";
import { createHubTodo, listHubTodos, updateHubTodo } from "../lib/hub-actions";

export { APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS } from "../lib/apple-maps-offline";
const RETRY_AFTER_TRANSIENT_FAILURE_MS = APPLE_MAPS_OFFLINE_RETRY_INTERVAL_MS;
const SAFE_REFRESH_WINDOW_CLOSED_ERROR = "The five-minute safe preflight refresh window has passed; the durable reminder stays unchanged.";
const REMINDER_REFRESHED_HUB_TODO_UNCHANGED_ERROR = "The durable reminder was refreshed before the safe window closed; the Hub to-do was not changed.";
const REMINDER_REFRESHED_HUB_TODO_RETRY_ERROR = "The durable reminder was refreshed before the safe window closed; the Hub to-do needs a retry.";
const REMINDER_AND_HUB_REFRESHED_WINDOW_CLOSED_ERROR = "The durable reminder and Hub to-do were refreshed before the safe window closed; no further automatic refresh will run.";

type ConvexCall = (path: string, args: Record<string, unknown>) => Promise<any>;

type RegistryPreflight = {
  city: string;
  flightMarker: string;
  flightTitle: string;
  flightStart: number;
  at: number;
  timeZone: string;
  mapUrl: string;
  todoText: string;
  reminderText: string;
};

type DuePreflight = {
  _id: string;
  updatedAt: number;
  sourceKey: string;
  preflight: RegistryPreflight;
  flightIdentity: AppleMapsOfflineGmailIdentity;
  cityProofIdentity: AppleMapsOfflineGmailIdentity;
  cityProof: AppleMapsOfflineCityProof;
  creation?: { _id: string; kind?: string; data?: string } | null;
};

export type AppleMapsOfflineRefreshDependencies = {
  query: ConvexCall;
  mutation: ConvexCall;
  lookupBooking?: (identity: AppleMapsOfflineGmailIdentity) => Promise<ConfirmedBooking | null>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

async function upsertTodo(
  preflight: { sourceKey: string; todoText: string; at: number },
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
): Promise<"created" | "existing" | "needs_retry" | "too_late"> {
  const tags = ["jarvis", "travel", "apple-maps", appleMapsOfflineHubTodoTag(preflight.sourceKey)];
  const options = { fetchImpl };
  const findExisting = (todos: unknown): any | undefined => Array.isArray(todos)
    ? todos.find((todo: any) => !todo?.done
      && Array.isArray(todo?.tags)
      && todo.tags.some((tag: unknown) => matchesAppleMapsOfflineHubTodoTag(tag, preflight.sourceKey)))
    : undefined;
  const reflectsPreflight = (todo: any): boolean => Boolean(todo)
    && String(todo.text ?? "") === preflight.todoText
    && Number(todo.dueDate) === preflight.at
    && Array.isArray(todo.tags)
    && todo.tags.some((tag: unknown) => matchesAppleMapsOfflineHubTodoTag(tag, preflight.sourceKey));
  try {
    const existing = findExisting(await listHubTodos(options));
    // Listing is read-only. Take a fresh clock just before the Hub mutation so
    // a slow list response cannot move a write into the protected window.
    if (!isAppleMapsOfflinePreflightRefreshWindowOpen(preflight.at, now())) return "too_late";
    if (existing?.id) {
      await updateHubTodo({ id: existing.id, text: preflight.todoText, dueDate: preflight.at }, options);
      return "existing";
    }
    await createHubTodo({ text: preflight.todoText, dueDate: preflight.at, tags }, options);
    return "created";
  } catch {
    // A response can be lost after the scoped facade accepts a create. Re-list
    // by the deterministic source tag before exposing a retry, so the next
    // scheduled pass cannot create a duplicate travel task. Missing Hub
    // capability still fails before either network request.
    try {
      const existing = findExisting(await listHubTodos(options));
      if (reflectsPreflight(existing)) return "existing";
    } catch {
      // The durable Jarvis reminder remains saved; surface an honest retry.
    }
    return "needs_retry";
  }
}

async function markPending(
  mutation: ConvexCall,
  row: DuePreflight,
  state: "pending_refresh" | "pending_google" | "needs_flight_confirmation" | "needs_city_confirmation" | "too_late" | "trip_missing",
  error: string,
  checkedAt: number,
  nextAt?: number,
): Promise<void> {
  await mutation("appleMapsOfflinePreflights:markPending", {
    id: row._id, expectedUpdatedAt: row.updatedAt, state, error, checkedAt,
    ...(nextAt === undefined ? {} : { nextRefreshAt: nextAt }),
  }).catch(() => {});
}

async function refreshWindowNow(
  mutation: ConvexCall,
  row: DuePreflight,
  preflightAt: number,
  now: () => number,
): Promise<number | undefined> {
  const checkedAt = now();
  if (isAppleMapsOfflinePreflightRefreshWindowOpen(preflightAt, checkedAt)) return checkedAt;
  await markPending(mutation, row, "too_late", SAFE_REFRESH_WINDOW_CLOSED_ERROR, checkedAt);
  return undefined;
}

async function refreshOne(
  row: DuePreflight,
  dependencies: Required<Pick<AppleMapsOfflineRefreshDependencies, "mutation" | "lookupBooking" | "fetch" | "now">>,
): Promise<"refreshed" | "pending" | "skipped"> {
  const now = dependencies.now();
  // The stored preflight is an early fail-closed boundary. Do not read Gmail
  // for an itinerary whose protected reminder window has already started.
  if (!isAppleMapsOfflinePreflightRefreshWindowOpen(row.preflight.at, now)) {
    await markPending(dependencies.mutation, row, "too_late", SAFE_REFRESH_WINDOW_CLOSED_ERROR, now);
    return "skipped";
  }
  if (!row.creation || row.creation.kind !== "trip" || typeof row.creation.data !== "string") {
    await markPending(dependencies.mutation, row, "trip_missing", "The saved trip is no longer available", now);
    return "pending";
  }
  const cityProof = currentAppleMapsOfflineCityProof(row.cityProof, now);
  if (!cityProof) {
    await markPending(dependencies.mutation, row, "needs_city_confirmation", "The booked-stay proof is no longer current", now);
    return "pending";
  }

  let flight: ConfirmedBooking | null;
  let stay: ConfirmedBooking | null;
  try {
    [flight, stay] = await Promise.all([
      dependencies.lookupBooking(row.flightIdentity),
      dependencies.lookupBooking(row.cityProofIdentity),
    ]);
  } catch {
    const checkedAt = await refreshWindowNow(dependencies.mutation, row, row.preflight.at, dependencies.now);
    if (checkedAt === undefined) return "skipped";
    await markPending(dependencies.mutation, row, "pending_google", "Gmail itinerary access is unavailable", checkedAt, checkedAt + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS);
    return "pending";
  }
  if (!flight) {
    const checkedAt = await refreshWindowNow(dependencies.mutation, row, row.preflight.at, dependencies.now);
    if (checkedAt === undefined) return "skipped";
    await markPending(dependencies.mutation, row, "needs_flight_confirmation", "The selected Gmail flight could not be confirmed", checkedAt);
    return "pending";
  }
  if (!stay || !matchesAppleMapsOfflineCityProof(stay, cityProof)) {
    const checkedAt = await refreshWindowNow(dependencies.mutation, row, row.preflight.at, dependencies.now);
    if (checkedAt === undefined) return "skipped";
    await markPending(dependencies.mutation, row, "needs_city_confirmation", "The selected Gmail booked stay changed; Jarvis will not guess the city", checkedAt);
    return "pending";
  }

  const built = buildAppleMapsOfflinePreflight({
    city: row.preflight.city,
    flights: [{ ...flight, tripVerified: true }],
    sourceKey: row.sourceKey,
    now,
  });
  if (built.status === "too_late") {
    await markPending(dependencies.mutation, row, "too_late", "The one-day-before preparation time has passed", now);
    return "skipped";
  }
  if (built.status !== "ready") {
    const checkedAt = await refreshWindowNow(dependencies.mutation, row, row.preflight.at, dependencies.now);
    if (checkedAt === undefined) return "skipped";
    await markPending(dependencies.mutation, row, "needs_flight_confirmation", "The selected Gmail flight needs confirmation", checkedAt, checkedAt + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS);
    return "pending";
  }
  // The saved reminder remains owner-visible until this mutation succeeds. A
  // Gmail itinerary may move its replacement later, but that must not let a
  // slow lookup revise the existing reminder after *its* protected window has
  // begun. Protect whichever reminder becomes due first.
  const protectedReminderAt = Math.min(row.preflight.at, built.preflight.at);
  const reminderAt = await refreshWindowNow(dependencies.mutation, row, protectedReminderAt, dependencies.now);
  if (reminderAt === undefined) return "skipped";

  try {
    // Reminders have the stable TripDoc source key, so Convex updates exactly
    // one pending reminder and retains an owner-cancelled one as cancelled.
    await dependencies.mutation("reminders:add", {
      text: built.preflight.reminderText,
      at: built.preflight.at,
      sourceKey: row.sourceKey,
    });
  } catch {
    const checkedAt = await refreshWindowNow(dependencies.mutation, row, protectedReminderAt, dependencies.now);
    if (checkedAt === undefined) return "skipped";
    await markPending(dependencies.mutation, row, "pending_refresh", "Jarvis could not update the durable reminder", checkedAt, checkedAt + RETRY_AFTER_TRANSIENT_FAILURE_MS);
    return "pending";
  }

  const todoStatus = await upsertTodo(built.preflight, dependencies.fetch, dependencies.now);
  // The reminder has already been safely updated. A slow, read-only Hub list
  // can cross the cutoff, but we must persist that successful reminder update
  // rather than claim it stayed unchanged. No later reminder or Hub mutation
  // is attempted in this branch.
  const completionAt = dependencies.now();
  const changed = built.preflight.flightMarker !== row.preflight.flightMarker
    || built.preflight.flightStart !== row.preflight.flightStart
    || built.preflight.at !== row.preflight.at
    || built.preflight.flightTitle !== row.preflight.flightTitle;
  const refreshedProof: AppleMapsOfflineCityProof = {
    ...cityProof,
    title: stay.title.slice(0, 180),
    ...(stay.bookingName ? { bookingName: stay.bookingName.slice(0, 180) } : {}),
    location: String(stay.location ?? cityProof.location).slice(0, 300),
    start: Number(stay.start), end: Number(stay.end ?? stay.start),
    ...(stay.timeZone ? { timeZone: stay.timeZone.slice(0, 80) } : {}),
    verifiedAt: completionAt,
  };
  const persistedTodoStatus = todoStatus === "too_late" ? "needs_retry" : todoStatus;
  const nextRefreshAt = nextAppleMapsOfflinePreflightRefreshAt(
    built.preflight.at,
    completionAt,
    persistedTodoStatus === "needs_retry",
  );
  const refreshState = nextRefreshAt === null ? "too_late" as const : "scheduled" as const;
  const refreshError = refreshState === "too_late"
    ? todoStatus === "too_late"
      ? REMINDER_REFRESHED_HUB_TODO_UNCHANGED_ERROR
      : persistedTodoStatus === "needs_retry"
        ? REMINDER_REFRESHED_HUB_TODO_RETRY_ERROR
        : REMINDER_AND_HUB_REFRESHED_WINDOW_CLOSED_ERROR
    : undefined;
  const complete = await dependencies.mutation("appleMapsOfflinePreflights:completeRefresh", {
    id: row._id,
    expectedUpdatedAt: row.updatedAt,
    preflight: built.preflight,
    flightIdentity: appleMapsOfflineGmailIdentity(flight, row.flightIdentity.selectionId),
    cityProofIdentity: appleMapsOfflineGmailIdentity(stay, row.cityProofIdentity.selectionId),
    cityProof: refreshedProof,
    checkedAt: completionAt,
    nextRefreshAt: nextRefreshAt ?? undefined,
    refreshState,
    ...(refreshError ? { refreshError } : {}),
    todoStatus: persistedTodoStatus,
    // Calendar writes remain an owner approval. A shifted event is shown as a
    // fresh approval requirement instead of an invisible external update.
    calendarRefreshRequired: changed,
  }).catch(() => ({ ok: false }));
  return complete?.ok ? "refreshed" : "pending";
}

/** Bounded maintenance entry point for the one-minute fleet supervisor. */
export async function refreshAppleMapsOfflinePreflights(
  dependencies: AppleMapsOfflineRefreshDependencies,
): Promise<{ due: number; refreshed: number; pending: number; skipped: number }> {
  const now = dependencies.now?.() ?? Date.now();
  const rows: DuePreflight[] = await dependencies.query("appleMapsOfflinePreflights:due", { now, limit: 4 }).catch(() => []);
  const resolved = {
    mutation: dependencies.mutation,
    lookupBooking: dependencies.lookupBooking ?? lookupGmailBookingForAppleMapsPreflight,
    fetch: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? (() => now),
  };
  let refreshed = 0;
  let pending = 0;
  let skipped = 0;
  for (const row of rows) {
    const outcome = await refreshOne(row, resolved).catch(() => "pending" as const);
    if (outcome === "refreshed") refreshed += 1;
    else if (outcome === "skipped") skipped += 1;
    else pending += 1;
  }
  return { due: rows.length, refreshed, pending, skipped };
}
