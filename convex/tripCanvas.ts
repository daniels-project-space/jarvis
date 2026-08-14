/**
 * Server-only canonical representation of a saved travel mind map.  Both the
 * draft promotion and later permanent-plan edits use this exact builder so a
 * route update cannot leave the visual plan behind the itinerary.
 */
export type TripCanvasRecord = Record<string, unknown>;

export const MAX_TRIP_CANVAS_BYTES = 120_000;

const MAX_TITLE_LENGTH = 120;
const MAX_DESTINATION_LENGTH = 180;

function isRecord(value: unknown): value is TripCanvasRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeText(value: unknown, max: number, fallback = ""): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : fallback;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function optionalUrl(key: "url" | "image", value: unknown): TripCanvasRecord {
  const url = safeUrl(value);
  return url ? { [key]: url } : {};
}

/**
 * Returns a bounded, source-safe canvas.  The client renderer derives layout
 * from this graph, so no browser-owned coordinates need to be persisted here.
 */
export function tripCanvas(doc: TripCanvasRecord): TripCanvasRecord | null {
  const destination = safeText(doc.destination, MAX_DESTINATION_LENGTH, "Trip");
  const title = `Trip map · ${destination}`.slice(0, MAX_TITLE_LENGTH);
  const locked = isRecord(doc.locked) ? doc.locked : {};
  const flight = isRecord(locked.flight) ? locked.flight : null;
  const stay = isRecord(locked.stay) ? locked.stay : null;
  const totals = isRecord(doc.totals) ? doc.totals : {};
  const nodes: TripCanvasRecord[] = [{
    id: "trip",
    label: safeText(doc.title, 80, title),
    detail: `£${Math.round(finiteNumber(totals.total)) || "?"} of £${Math.round(finiteNumber(doc.budgetGbp)) || "?"} · ${Math.max(1, Math.round(finiteNumber(doc.adults) || 1))} adults`,
    color: "green",
  }];
  const edges: TripCanvasRecord[] = [];

  if (flight) {
    nodes.push({
      id: "flight-out",
      label: `✈ ${safeText(doc.origin, 12, "origin")} → ${safeText(doc.destIata, 12, "destination")}`,
      detail: `${safeText(flight.airline, 60)} · ${safeText(flight.departTime, 24)} → ${safeText(flight.arriveTime, 24)} · £${Math.round(finiteNumber(flight.priceGbp)) || "?"}pp`,
      parent: "trip",
      color: "amber",
      ...optionalUrl("url", flight.bookLink),
    });
  }
  if (stay) {
    nodes.push({
      id: "hotel",
      label: `🏨 ${safeText(stay.name, 60, "selected stay")}`,
      detail: `£${Math.round(finiteNumber(stay.totalGbp)) || "?"} total`,
      parent: flight ? "flight-out" : "trip",
      color: "green",
      ...optionalUrl("url", stay.link),
      ...optionalUrl("image", stay.image),
    });
    if (flight && isRecord(doc.transfer)) {
      edges.push({
        from: "flight-out",
        to: "hotel",
        label: `${safeText(doc.transfer.durationText, 40, "transfer")} · ${safeText(doc.transfer.distanceText, 40)}`.replace(/ · $/, ""),
      });
    }
  }

  const days = Array.isArray(doc.itinerary) ? doc.itinerary : [];
  if (days.length > 60) return null;
  let stopCount = 0;
  for (const [dayIndex, rawDay] of days.entries()) {
    if (!isRecord(rawDay)) continue;
    const dayId = `day-${dayIndex + 1}`;
    const date = safeText(rawDay.date, 20, String(dayIndex + 1));
    nodes.push({
      id: dayId,
      label: `Day ${dayIndex + 1} · ${safeText(rawDay.label, 80, date)}`,
      parent: stay ? "hotel" : "trip",
      color: "slate",
    });
    const stopNodeIds = new Map<string, string>();
    if (stay) stopNodeIds.set(`stay:${date}`, "hotel");
    const items = Array.isArray(rawDay.items) ? rawDay.items : [];
    if (items.length > 64) return null;
    for (const [itemIndex, rawItem] of items.entries()) {
      if (!isRecord(rawItem) || !["activity", "booking"].includes(String(rawItem.kind))) continue;
      stopCount += 1;
      if (stopCount > 240) return null;
      const itemKey = safeText(rawItem.id, 80, `item-${itemIndex + 1}`);
      const nodeId = `${dayId}:${itemKey}`;
      stopNodeIds.set(itemKey, nodeId);
      nodes.push({
        id: nodeId,
        label: safeText(rawItem.title, 80, "planned stop"),
        detail: `${safeText(rawItem.time, 20, "time tbd")}${finiteNumber(rawItem.durationMinutes) ? ` · allow ${Math.round(finiteNumber(rawItem.durationMinutes))} min` : ""}${safeText(rawItem.note, 160) ? ` · ${safeText(rawItem.note, 160)}` : ""}`,
        parent: dayId,
        color: "blue",
        ...optionalUrl("url", rawItem.link),
      });
    }
    const route = isRecord(rawDay.route) ? rawDay.route : null;
    const legs = Array.isArray(route?.legs) ? route.legs : [];
    for (const rawLeg of legs.slice(0, 80)) {
      if (!isRecord(rawLeg)) continue;
      const from = stopNodeIds.get(safeText(rawLeg.fromItemId, 80));
      const to = stopNodeIds.get(safeText(rawLeg.toItemId, 80));
      if (!from || !to) continue;
      const minutes = Math.max(1, Math.round(finiteNumber(rawLeg.durationSeconds) / 60));
      const meters = finiteNumber(rawLeg.distanceMeters);
      const distance = meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${Math.round(meters)} m`;
      edges.push({ from, to, label: `${safeText(route?.mode, 20, "route")} · ${minutes} min · ${distance}` });
    }
  }
  if (flight) {
    nodes.push({
      id: "flight-home",
      label: `✈ ${safeText(doc.destIata, 12, "destination")} → ${safeText(doc.origin, 12, "origin")}`,
      detail: safeText(doc.returnDate, 20),
      parent: stay ? "hotel" : "trip",
      color: "amber",
      ...optionalUrl("url", flight.bookLink),
    });
    if (stay && isRecord(doc.transfer)) {
      edges.push({ from: "hotel", to: "flight-home", label: `${safeText(doc.transfer.durationText, 40, "transfer")} to airport` });
    }
  }
  const canvas: TripCanvasRecord = { title, nodes, edges };
  return JSON.stringify(canvas).length <= MAX_TRIP_CANVAS_BYTES ? canvas : null;
}
