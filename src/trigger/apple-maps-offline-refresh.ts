import { buildAppleMapsOfflinePreflight } from "../lib/apple-maps-offline";
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

export const APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const RETRY_AFTER_TRANSIENT_FAILURE_MS = 10 * 60_000;

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

function nextRefreshAt(preflightAt: number, now: number): number {
  return Math.max(now + 60_000, Math.min(preflightAt - 5 * 60_000, now + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS));
}

async function upsertTodo(
  preflight: { sourceKey: string; todoText: string; at: number },
  fetchImpl: typeof globalThis.fetch,
): Promise<"created" | "existing" | "needs_retry"> {
  const tags = ["jarvis", "travel", "apple-maps", appleMapsOfflineHubTodoTag(preflight.sourceKey)];
  const options = { fetchImpl };
  try {
    const todos = await listHubTodos(options);
    const existing = Array.isArray(todos)
      ? todos.find((todo: any) => !todo?.done
        && Array.isArray(todo?.tags)
        && todo.tags.some((tag: unknown) => matchesAppleMapsOfflineHubTodoTag(tag, preflight.sourceKey)))
      : undefined;
    if (existing?.id) {
      await updateHubTodo({ id: existing.id, text: preflight.todoText, dueDate: preflight.at }, options);
      return "existing";
    }
    await createHubTodo({ text: preflight.todoText, dueDate: preflight.at, tags }, options);
    return "created";
  } catch {
    // The scoped adapter rejects a missing capability before any network call.
    // The durable Jarvis reminder remains saved and the TripDoc exposes this
    // retry state instead of falling back to the old unauthenticated route.
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

async function refreshOne(
  row: DuePreflight,
  dependencies: Required<Pick<AppleMapsOfflineRefreshDependencies, "mutation" | "lookupBooking" | "fetch" | "now">>,
): Promise<"refreshed" | "pending" | "skipped"> {
  const now = dependencies.now();
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
    await markPending(dependencies.mutation, row, "pending_google", "Gmail itinerary access is unavailable", now, now + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS);
    return "pending";
  }
  if (!flight) {
    await markPending(dependencies.mutation, row, "needs_flight_confirmation", "The selected Gmail flight could not be confirmed", now);
    return "pending";
  }
  if (!stay || !matchesAppleMapsOfflineCityProof(stay, cityProof)) {
    await markPending(dependencies.mutation, row, "needs_city_confirmation", "The selected Gmail booked stay changed; Jarvis will not guess the city", now);
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
    await markPending(dependencies.mutation, row, "needs_flight_confirmation", "The selected Gmail flight needs confirmation", now, now + APPLE_MAPS_OFFLINE_REFRESH_INTERVAL_MS);
    return "pending";
  }

  try {
    // Reminders have the stable TripDoc source key, so Convex updates exactly
    // one pending reminder and retains an owner-cancelled one as cancelled.
    await dependencies.mutation("reminders:add", {
      text: built.preflight.reminderText,
      at: built.preflight.at,
      sourceKey: row.sourceKey,
    });
  } catch {
    await markPending(dependencies.mutation, row, "pending_refresh", "Jarvis could not update the durable reminder", now, now + RETRY_AFTER_TRANSIENT_FAILURE_MS);
    return "pending";
  }

  const todoStatus = await upsertTodo(built.preflight, dependencies.fetch);
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
    verifiedAt: now,
  };
  const complete = await dependencies.mutation("appleMapsOfflinePreflights:completeRefresh", {
    id: row._id,
    expectedUpdatedAt: row.updatedAt,
    preflight: built.preflight,
    flightIdentity: appleMapsOfflineGmailIdentity(flight, row.flightIdentity.selectionId),
    cityProofIdentity: appleMapsOfflineGmailIdentity(stay, row.cityProofIdentity.selectionId),
    cityProof: refreshedProof,
    checkedAt: now,
    nextRefreshAt: nextRefreshAt(built.preflight.at, now),
    todoStatus,
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
