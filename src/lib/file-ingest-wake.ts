/**
 * A release-only admission gate for the immediate Trigger wake-up. Uploads
 * remain durable while the gate is closed; the V2 activation task requeues
 * them after the old worker fleet has been fully quiesced.
 *
 * Keep this server-side and explicit. It is not an ingest-state transition or
 * a safety proof for an already-running worker.
 */
export function isFileIngestCutoverPaused() {
  return process.env.JARVIS_FILE_INGEST_WAKE_PAUSED === "1";
}

export function isFileIngestWakePaused() {
  return isFileIngestCutoverPaused();
}
